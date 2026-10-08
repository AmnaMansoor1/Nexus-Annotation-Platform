import { useState, useEffect, useCallback, useRef } from "react";
import { collection, query, getDocs, limit, doc, where, getCountFromServer, getDoc, setDoc, onSnapshot, writeBatch, enableNetwork, disableNetwork } from "firebase/firestore";
import Papa from "papaparse";
import { db } from "../firebase";
import { Article, PlatformSummary, Annotator, AdminConfig } from "../types";
import { getRequiredAnnotations } from "../utils/annotationConfig";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { 
  Newspaper, 
  CheckCircle2, 
  Clock, 
  Users, 
  TrendingUp,
  Activity,
  Loader2,
  RefreshCw,
  ShieldAlert,
  AlertTriangle,
  ListOrdered
} from "lucide-react";

export default function Dashboard() {
  const [stats, setStats] = useState<PlatformSummary>({
    totalArticles: 0,
    completedArticles: 0,
    inProgressArticles: 0,
    pendingArticles: 0,
    totalAnnotators: 0,
    completedAnnotators: 0,
    avgBiasScore: 0,
    totalBiasScoreSum: 0,
    needsReview: 0
  });

  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [statusData, setStatusData] = useState<any[]>([
    { name: "Completed", value: 0, color: "#16a34a" },
    { name: "In Progress", value: 0, color: "#eab308" },
    { name: "Pending", value: 0, color: "#94a3b8" }
  ]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [staleSummary, setStaleSummary] = useState(false);
  const [repairingSeq, setRepairingSeq] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ step: string; processed: number; total: number } | null>(null);
  const seqCsvInputRef = useRef<HTMLInputElement | null>(null);

  // ─────────────────────────────────────────────────────────────────────
  // Retry wrapper: detects transient Firestore errors with exponential
  // backoff. Every 2nd failed attempt, cycles disableNetwork/enableNetwork
  // to force the WebChannel/gRPC transport to fully reconnect (fixes
  // "client is offline" after Wi-Fi or proxy drops the stream for >10s).
  // ─────────────────────────────────────────────────────────────────────
  async function runWithRetries<T>(
    label: string,
    fn: () => Promise<T>,
    opts: { attempts?: number; baseDelayMs?: number } = {}
  ): Promise<T> {
    const attempts = opts.attempts ?? 8;
    const baseDelay = opts.baseDelayMs ?? 2000;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        if (i > 0) console.warn(`[SyncStats] ${label}: retry ${i}/${attempts - 1}`);
        const out = await fn();
        if (i > 0) console.log(`[SyncStats] ${label}: retry ${i} succeeded.`);
        return out;
      } catch (e: any) {
        lastErr = e;
        const code = String(e?.code || "");
        const msg = String(e?.message || e || "");
        const transient =
          code === "unavailable" ||
          code === "deadline-exceeded" ||
          code === "aborted" ||
          code === "resource-exhausted" ||
          code === "internal" ||
          code === "data-loss" ||
          code === "cancelled" ||
          /offline|network|timeout|connection|socket|reset|rpc|channel/i.test(msg);
        if (!transient || i === attempts - 1) {
          console.error(`[SyncStats] ${label}: fatal after ${i + 1} tries. code=${code}. transient=${transient}`, e);
          throw e;
        }
        const delay = baseDelay * Math.pow(1.6, i);
        const clamped = Math.min(delay, 20000);
        console.warn(`[SyncStats] ${label}: transient code=${code}. attempt=${i + 1}/${attempts}. sleeping ${clamped}ms then full SDK network-cycle.`);
        await new Promise(res => setTimeout(res, clamped));
        // Every retry, cycle disableNetwork→enableNetwork to guarantee the
        // Firestore SDK drops its dead WebChannel and re-opens a fresh one.
        try { await disableNetwork(db); } catch (_) { /* swallow */ }
        await new Promise(res => setTimeout(res, 250));
        try { await enableNetwork(db); } catch (_) { /* swallow */ }
        await new Promise(res => setTimeout(res, 500));
      }
    }
    throw lastErr;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Timeout wrapper: races a promise against a deadline. If the promise
  // doesn't resolve within `ms` milliseconds it rejects with a timeout
  // error. This is critical for getDocs() on large collections — the
  // Firestore SDK can silently hang (promise never resolves OR rejects)
  // if the underlying WebChannel is stuck, which defeats the retry loop.
  // ─────────────────────────────────────────────────────────────────────
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`[Timeout] ${label} timed out after ${ms / 1000}s — network cycle will retry`)),
          ms
        )
      ),
    ]);
  }


  const handleRepairSequenceNumbers = () => {
    seqCsvInputRef.current?.click();
  };

  const onSeqCsvSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm(
      "This will REWRITE sequence_number on ALL 1493 articles using the ORDER in your CSV file.\n\n" +
      "• Row 1 (after header) → sequence_number = 1\n" +
      "• Row 2 → sequence_number = 2, ...\n" +
      "• Last row → sequence_number = 1493\n\n" +
      "This fixes the bug where articles were assigned NON-sequentially (lexicographic by article_id) instead of in CSV order.\n" +
      "Required annotator slots are preserved. Only sequence_number is changed.\n\n" +
      "Only click OK if this is the SAME CSV used to seed the dataset (annotation_dataset_v6.csv).\n\n" +
      "Proceed?"
    )) {
      e.target.value = "";
      return;
    }

    setRepairingSeq(true);
    try {
      const text = await file.text();
      const parseResult = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parseResult.errors.length > 0) {
        throw new Error(`CSV parse error: ${parseResult.errors[0].message}`);
      }
      const rows = parseResult.data as Array<{ article_id: string }>;
      if (!rows[0] || !rows[0].article_id) {
        throw new Error("CSV missing 'article_id' column in first data row.");
      }
      console.log(`[RepairSeq] Parsed ${rows.length} rows from CSV. Building sequence_number map...`);

      // Build Map<article_id, sequence_number (1-based)>
      const seqByArticleId = new Map<string, number>();
      let duplicateCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const id = rows[i].article_id;
        if (!id) continue;
        if (seqByArticleId.has(id)) duplicateCount++;
        seqByArticleId.set(id, i + 1);
      }
      console.log(`[RepairSeq] Map size: ${seqByArticleId.size}. Duplicates found: ${duplicateCount}`);

      // Fetch ALL articles from Firestore
      const allArticlesSnap = await getDocs(collection(db, "articles"));
      const totalArticles = allArticlesSnap.size;
      console.log(`[RepairSeq] Articles in Firestore: ${totalArticles}. Starting batch writes (500/batch)...`);

      const MAX_BATCH = 500;
      let batch = writeBatch(db);
      let batchCount = 0;
      let updatedCount = 0;
      let missingFromCsv = 0;
      let unchangedCount = 0;

      for (const docSnap of allArticlesSnap.docs) {
        const existingSeq = docSnap.get("sequence_number");
        const newSeq = seqByArticleId.get(docSnap.id);
        if (newSeq === undefined) { missingFromCsv++; continue; }
        if (existingSeq === newSeq) { unchangedCount++; continue; }
        batch.set(doc(db, "articles", docSnap.id), { sequence_number: newSeq }, { merge: true });
        batchCount++;
        updatedCount++;
        if (batchCount >= MAX_BATCH) {
          await batch.commit();
          batch = writeBatch(db);
          batchCount = 0;
        }
      }
      if (batchCount > 0) await batch.commit();

      console.log(`[RepairSeq] DONE. Updated: ${updatedCount}, unchanged: ${unchangedCount}, missing-in-CSV: ${missingFromCsv}`);
      alert(
        `✅ sequence_number repair complete.\n\n` +
        `Articles updated: ${updatedCount}\n` +
        `Already correct (no-op): ${unchangedCount}\n` +
        `Missing-in-CSV (skipped): ${missingFromCsv}\n\n` +
        `CSV first article → seq=1 (${seqByArticleId.size > 0 ? (rows[0].article_id ?? '?') : '?'}).\n` +
        `CSV last article → seq=${rows.length} (${rows[rows.length-1]?.article_id ?? '?'}).\n\n` +
        "Next new annotator will receive articles strictly by sequence_number 1, 2, 3,... until each article has 5 annotators, then moves to seq 21, 22, 23,..."
      );
    } catch (err: any) {
      console.error("[RepairSeq] Failed:", err);
      alert("Failed to repair sequence numbers: " + (err?.message ?? String(err)));
    } finally {
      setRepairingSeq(false);
      if (e.target) e.target.value = "";
    }
  };

  const applyStatsData = useCallback((data: PlatformSummary) => {
    // Clamp all counts to ≥ 0 — a negative stored value means the summary
    // doc is stale/corrupted and needs a Sync. Show 0 instead of a negative.
    const safe = (v: any) => Math.max(0, typeof v === "number" && Number.isFinite(v) ? v : 0);
    const clamped: PlatformSummary = {
      ...data,
      totalArticles:      safe(data.totalArticles),
      completedArticles:  safe(data.completedArticles),
      inProgressArticles: safe(data.inProgressArticles),
      pendingArticles:    safe(data.pendingArticles),
      totalAnnotators:    safe(data.totalAnnotators),
      completedAnnotators: safe(data.completedAnnotators),
      avgBiasScore:       safe(data.avgBiasScore),
      needsReview:        safe(data.needsReview),
    };
    if (data.completedArticles < 0 || data.inProgressArticles < 0 || data.pendingArticles < 0) {
      console.warn(
        "[Dashboard] Negative stat detected in platform_summary doc \u2014 doc is stale. " +
        `completedArticles=${data.completedArticles}, inProgress=${data.inProgressArticles}, pending=${data.pendingArticles}. ` +
        "Run Sync Statistics to rebuild."
      );
      setStaleSummary(true);
    } else {
      setStaleSummary(false);
    }
    setStats(clamped);
    setStatusData([
      { name: "Completed", value: clamped.completedArticles, color: "#16a34a" },
      { name: "In Progress", value: clamped.inProgressArticles, color: "#eab308" },
      { name: "Pending", value: clamped.pendingArticles, color: "#94a3b8" }
    ]);
    if (data.categoryDistribution) {
      setCategoryData(Object.entries(data.categoryDistribution)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
      );
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let didInitialLoad = false;

    const summaryRef = doc(db, "stats", "platform_summary");
    const unsubscribe = onSnapshot(summaryRef, (snap) => {
      try {
        if (!snap.exists()) {
          throw new Error("Stats summary not found. Please click 'Sync Statistics' below to initialize.");
        }
        const data = snap.data() as PlatformSummary;
        applyStatsData(data);
        setError(null);
      } catch (err: any) {
        console.error("Dashboard data load error:", err);
        setError(err.message || "Failed to load dashboard data.");
      } finally {
        if (!didInitialLoad) {
          didInitialLoad = true;
          setLoading(false);
        }
      }
    }, (err) => {
      console.error("Dashboard snapshot error:", err);
      setError(err.message || "Failed to connect to dashboard stream.");
      setLoading(false);
    });

    return () => unsubscribe();
  }, [applyStatsData]);

  const handleSyncStats = async () => {
    if (!window.confirm(
      "This will perform a full database consistency repair and statistics sync.\n\n" +
      "STEP 1 — Article-Level Repair:\n" +
      "  • Remove deleted/unknown annotators from every article's assigned_to/annotated_by\n" +
      "  • Rebuild assigned_count/annotation_count to match ONLY live annotators\n" +
      "  • Recalculate status (pending/partial/complete) and clear bias_score when count drops\n\n" +
      "STEP 2 — Rebuild Platform Summary (stats/platform_summary)\n\n" +
      "This is required after annotator deletions and fixes the 'new users get articles starting at seq 40+' bug.\n\n" +
      "The operation is IDempotent — if your internet drops mid-run, simply click Run Sync & Repair again.\n\n" +
      "Continue?"
    )) return;

    setSyncing(true);
    setSyncProgress({ step: "Preparing: re-enabling Firestore network + fetching annotators + articles…", processed: 0, total: 0 });
    setError(null);
    try {
      console.log("[SyncStats] Starting full statistics sync with article consistency repair (offline-retry build).");

      try {
        await enableNetwork(db);
        await new Promise(r => setTimeout(r, 250));
      } catch (ne) {
        console.warn("[SyncStats] enableNetwork threw (harmless if already online):", ne);
      }

      // ── 1. FETCH ALL articles + annotators
      // withTimeout(45s) is critical: getDocs on a large collection can silently
      // hang in the browser (promise never resolves OR rejects) if the Firestore
      // WebChannel is stuck. The timeout forces a rejection so the retry loop
      // can cycle disableNetwork→enableNetwork and re-open a fresh connection.
      const fetchStart = performance.now();
      setSyncProgress({ step: "Fetching annotators from Firestore…", processed: 0, total: 0 });
      const annotatorsSnap = await runWithRetries(
        "fetch annotators",
        async () => {
          try { await enableNetwork(db); } catch (_) {}
          return withTimeout(getDocs(collection(db, "annotators")), 45_000, "annotators fetch");
        },
        { attempts: 6, baseDelayMs: 3000 }
      );
      console.log(`[SyncStats] Fetched ${annotatorsSnap.size} annotators in ${Math.round(performance.now() - fetchStart)} ms`);

      setSyncProgress({ step: `Fetching ${1493} articles from Firestore — this may take 10–30 s on a slow connection…`, processed: 0, total: 0 });
      const articlesFetchStart = performance.now();
      const articlesSnap = await runWithRetries(
        "fetch articles collection",
        async () => {
          try { await enableNetwork(db); } catch (_) {}
          return withTimeout(getDocs(collection(db, "articles")), 60_000, "articles fetch");
        },
        { attempts: 6, baseDelayMs: 3000 }
      );
      console.log(`[SyncStats] Fetched ${articlesSnap.size} articles in ${Math.round(performance.now() - articlesFetchStart)} ms`);

      const liveAnnotatorEmails = new Set<string>();
      const articlesByAssignee = new Map<string, Set<string>>();
      const annotators: Annotator[] = [];
      annotatorsSnap.forEach(d => {
        const a = d.data() as Annotator;
        annotators.push(a);
        const email = typeof a.email === "string" ? a.email.toLowerCase().trim() : "";
        if (!email) return;
        liveAnnotatorEmails.add(email);
        const assigned = Array.isArray(a.assigned_articles) ? a.assigned_articles : [];
        for (const articleId of assigned) {
          if (!articleId) continue;
          if (!articlesByAssignee.has(articleId)) articlesByAssignee.set(articleId, new Set());
          articlesByAssignee.get(articleId)!.add(email);
        }
      });
      console.log(
        `[SyncStats] Live annotators found: ${liveAnnotatorEmails.size}.`,
        `Truth map: ${articlesByAssignee.size} articles with slots.`,
        `Any reference outside the truth map (ghost assignees) will be repaired.`
      );

      const settingsSnap = await runWithRetries(
        "read admin_config/settings",
        () => getDoc(doc(db, "admin_config", "settings")),
        { attempts: 3, baseDelayMs: 750 }
      );
      const settings = settingsSnap.exists() ? (settingsSnap.data() as AdminConfig) : null;
      const fallbackRequiredAnnotations = getRequiredAnnotations(null, settings);

      // ─────────────────────────────────────────────────────────────
      // STEP 1 — REPAIR EVERY ARTICLE against live annotators
      //
      // Process in chunks of 100; after each chunk commit, yield to
      // the browser so the progress banner visibly updates.
      // Each batch.commit has its own 3-attempt retry + backoff so
      // transient "client is offline" blips get auto-resolved.
      // ─────────────────────────────────────────────────────────────
      let repairedCount = 0;
      let freedSlotsTotal = 0;
      const articleDocs = articlesSnap.docs;
      const TOTAL_ARTICLES = articleDocs.length;

      const MAX_BATCH = 100; // smaller batches = each commit has smaller chance of offline failure
      let batch = writeBatch(db);
      let batchCount = 0;
      let checkpointProcessed = 0;

      const repairedArticles: Article[] = new Array(TOTAL_ARTICLES);

      function uniqueEmails(emails: string[], predicate?: (e: string) => boolean): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of emails) {
          const n = (raw || "").toLowerCase().trim();
          if (!n || seen.has(n)) continue;
          if (predicate && !predicate(n)) continue;
          seen.add(n);
          out.push(n);
        }
        return out;
      }

      setSyncProgress({ step: "Repairing article metadata (status / counts / scores)", processed: 0, total: TOTAL_ARTICLES });

      for (let i = 0; i < TOTAL_ARTICLES; i++) {
        const docSnap = articleDocs[i];
        const article = docSnap.data() as Article;
        const requiredAnnotations = getRequiredAnnotations(article, settings);

        const oldAssignedTo = Array.isArray(article.assigned_to) ? article.assigned_to : [];
        const oldAnnotatedBy = Array.isArray(article.annotated_by) ? article.annotated_by : [];
        const oldAssignedCount = typeof article.assigned_count === "number" ? article.assigned_count : 0;
        const oldAnnotationCount = typeof article.annotation_count === "number" ? article.annotation_count : 0;

        const truthAssignees = articlesByAssignee.get(docSnap.id) ?? new Set<string>();

        const newAssignedTo = truthAssignees.size > 0
          ? uniqueEmails([...truthAssignees])
          : uniqueEmails(oldAssignedTo, (e) => liveAnnotatorEmails.has(e));
        const newAnnotatedBy = uniqueEmails(oldAnnotatedBy, (e) => liveAnnotatorEmails.has(e));
        const newAssignedCount = newAssignedTo.length;
        const newAnnotationCount = newAnnotatedBy.length;

        const slotDelta = (oldAssignedCount - newAssignedCount) + (oldAnnotationCount - newAnnotationCount);
        let needsRepair =
          oldAssignedCount !== newAssignedCount ||
          oldAnnotationCount !== newAnnotationCount ||
          oldAssignedTo.length !== newAssignedTo.length ||
          oldAnnotatedBy.length !== newAnnotatedBy.length;

        let newStatus: Article["status"] = article.status;
        if (newAnnotationCount >= requiredAnnotations) newStatus = "complete";
        else if (newAnnotationCount > 0) newStatus = "partial";
        else newStatus = "pending";

        if (newStatus !== article.status) needsRepair = true;

        const updates: any = {
          assigned_to: newAssignedTo,
          assigned_count: newAssignedCount,
          annotated_by: newAnnotatedBy,
          annotation_count: newAnnotationCount,
          status: newStatus,
        };

        if (newAnnotationCount < requiredAnnotations) {
          if (article.bias_score !== null) { updates.bias_score = null; needsRepair = true; }
          if (article.percent_agreement !== null) { updates.percent_agreement = null; needsRepair = true; }
          if (article.final_label !== null) { updates.final_label = null; needsRepair = true; }
          if (article.label !== null && article.label !== undefined) { updates.label = null; needsRepair = true; }
        }

        const repaired: Article = {
          ...article,
          ...updates,
        };
        repairedArticles[i] = repaired;

        if (needsRepair) {
          repairedCount++;
          freedSlotsTotal += Math.max(0, slotDelta);
          if (batchCount >= MAX_BATCH) {
            await runWithRetries(
              `commit article batch (${batchCount} writes, progress ${checkpointProcessed + 1}-${i + 1}/${TOTAL_ARTICLES})`,
              async () => { try { await enableNetwork(db); } catch(_){} return batch.commit(); },
              { attempts: 4, baseDelayMs: 1500 }
            );
            batch = writeBatch(db);
            batchCount = 0;
            checkpointProcessed = i;
            setSyncProgress({ step: "Repairing article metadata (status / counts / scores)", processed: i + 1, total: TOTAL_ARTICLES });
            // yield to the browser so React actually paints the progress banner
            await new Promise(res => setTimeout(res, 10));
          }
          batch.set(doc(db, "articles", docSnap.id), updates, { merge: true });
          batchCount++;
        }
      }

      if (batchCount > 0) {
        await runWithRetries(
          `commit final article batch (${batchCount} writes; tail of run)`,
          async () => { try { await enableNetwork(db); } catch(_){} return batch.commit(); },
          { attempts: 4, baseDelayMs: 1500 }
        );
      }
      setSyncProgress({ step: "Article metadata repair complete. Computing platform summary…", processed: TOTAL_ARTICLES, total: TOTAL_ARTICLES });
      console.log(`[SyncStats] Article-level repair complete. Repaired: ${repairedCount} articles. Assignment/annotation slots freed: ~${freedSlotsTotal}.`);

      const articles = repairedArticles;

      // 2. Calculate category distribution
      const categories = articles.reduce((acc: Record<string, number>, article) => {
        const cat = article.category || "Uncategorized";
        acc[cat] = (acc[cat] || 0) + 1;
        return acc;
      }, {});

      // 3. Build new summary
      const completedAnnotatorCount = annotators.filter(a =>
        Array.isArray(a.completed_articles) && a.completed_articles.length >= 20
      ).length;
      const completedArticlesArr = articles.filter(a => a.status === "complete");
      const totalBiasScoreSum = completedArticlesArr.reduce((sum, a) => {
        const v = typeof a.bias_score === "number" && Number.isFinite(a.bias_score) ? a.bias_score : 0;
        return sum + v;
      }, 0);
      const avgBiasScore = completedArticlesArr.length > 0
        ? Math.round((totalBiasScoreSum / completedArticlesArr.length) * 100) / 100
        : 0;
      const totalA = articles.length;
      const completedA = Math.max(0, completedArticlesArr.length);
      const inProgressA = Math.max(0, articles.filter(a => a.status === "partial").length);
      const pendingA = Math.max(0, totalA - completedA - inProgressA);

      const newSummary: PlatformSummary = {
        totalArticles: totalA,
        completedArticles: completedA,
        inProgressArticles: inProgressA,
        pendingArticles: pendingA,
        totalAnnotators: annotators.length,
        completedAnnotators: completedAnnotatorCount,
        avgBiasScore,
        totalBiasScoreSum,
        needsReview: Math.max(0, articles.filter(a => {
          const requiredAnnotations = getRequiredAnnotations(a, {
            annotators_per_article: fallbackRequiredAnnotations,
          });
          return a.status === "partial" && a.annotation_count >= requiredAnnotations;
        }).length),
        categoryDistribution: categories
      };

      // 4. Update Firestore summary (with retry)
      setSyncProgress({ step: "Writing stats/platform_summary doc (final step)", processed: TOTAL_ARTICLES, total: TOTAL_ARTICLES });
      await runWithRetries(
        "write stats/platform_summary",
        async () => { try { await enableNetwork(db); } catch(_){} return setDoc(doc(db, "stats", "platform_summary"), newSummary); },
        { attempts: 4, baseDelayMs: 1200 }
      );

      // 5. Update local state
      setStats(newSummary);
      setStatusData([
        { name: "Completed", value: newSummary.completedArticles, color: "#16a34a" },
        { name: "In Progress", value: newSummary.inProgressArticles, color: "#eab308" },
        { name: "Pending", value: newSummary.pendingArticles, color: "#94a3b8" }
      ]);
      setCategoryData(Object.entries(categories)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
      );
      setSyncProgress(null);

      alert(
        `✅ Consistency Repair & Sync Complete.\n\n` +
        `Articles repaired: ${repairedCount}\n` +
        `Assignment slots freed: ${freedSlotsTotal}\n` +
        `Next new annotator will receive articles starting from the LOWEST sequence_number.\n\n` +
        `Summary: ${newSummary.pendingArticles} pending / ${newSummary.inProgressArticles} partial / ${newSummary.completedArticles} complete.`
      );
    } catch (err: any) {
      console.error("Sync error:", err);
      const code = err?.code ? String(err.code) : "";
      const msg = err?.message ? String(err.message) : String(err);
      const wasOffline =
        code === "unavailable" || /offline|network|timeout|connection|client/i.test(msg);
      alert(
        (wasOffline ? "⚠️  Your connection dropped mid-sync (client offline).\n\n" : "❌ Sync failed.\n\n") +
        `Error code: ${code || "n/a"}\n${msg}\n\n` +
        "GOOD NEWS: every batch commit is IDEMPOTENT — you have NOT corrupted data.\n" +
        "Simply click Run Sync & Repair again. The new build will:\n" +
        "  • Re-write the same metadata (no double-counting)\n" +
        "  • Auto-retry each batch 4× with backoff if your Wi-Fi wobbles\n" +
        "  • Use 100-write batches (smaller = less chance of offline failure)\n\n" +
        "If you keep seeing this, keep the Chrome DevTools Network tab open next run and check for red WebSocket/Firestore disconnects."
      );
      setSyncProgress(null);
    } finally {
      setSyncing(false);
      setSyncProgress(prev => prev && prev.processed < prev.total ? prev : null);
    }
  };


  const statCards = [
    { label: "Total Articles", value: stats.totalArticles, icon: Newspaper, color: "bg-blue-500" },
    { label: "Fully Annotated", value: stats.completedArticles, icon: CheckCircle2, color: "bg-green-500" },
    { label: "In Progress", value: stats.inProgressArticles, icon: Clock, color: "bg-yellow-500" },
    { label: "Pending", value: stats.pendingArticles, icon: TrendingUp, color: "bg-slate-400" },
  ];

  if (loading) {
    return (
      <div className="bg-white p-10 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-center gap-3 text-slate-500">
        <Loader2 className="animate-spin text-primary" size={24} />
        <span className="font-medium">Loading dashboard...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4 animate-in fade-in duration-500">
        <div className="bg-red-50 p-6 rounded-2xl border border-red-200 text-red-700 space-y-3">
          <h2 className="text-lg font-bold">Admin Dashboard Unavailable</h2>
          <p className="text-sm">{error}</p>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-4">
          <div className="flex items-start gap-3">
            <div className="bg-amber-100 w-9 h-9 rounded-xl flex items-center justify-center shrink-0">
              <AlertTriangle className="text-amber-600" size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-bold text-slate-800">Recovery Procedure</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Click <span className="font-semibold text-slate-800">Run Sync &amp; Repair</span> below once.
                This will (1) rebuild every article's <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs font-mono">status / annotation_count / assigned_count / bias_score / percent_agreement / final_label</code> metadata
                against live annotators using the current <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs font-mono">annotators_per_article</code> setting
                (e.g. 3 default, or whatever per-article override you configured in Settings),
                and (2) write the missing <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs font-mono">stats/platform_summary</code> document.
                After the process completes (~10–60 seconds), the dashboard will automatically switch to the normal live view.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleSyncStats}
              disabled={syncing}
              className="flex items-center gap-2 bg-red-600 px-5 py-3 rounded-xl text-white font-bold text-sm hover:bg-red-700 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
              {syncing ? "Running Sync & Repair — do not close the tab..." : "Run Sync & Repair (fixes missing stats + article metadata)"}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 bg-white px-4 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all shadow-sm"
            >
              Refresh Page
            </button>
          </div>

          {syncing && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-4 font-medium space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 size={12} className="animate-spin shrink-0" />
                <div className="flex-1">
                  <span className="font-bold">
                    {syncProgress?.step || "Running Sync & Repair…"}
                  </span>
                  {syncProgress && syncProgress.total > 0 && (
                    <>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-amber-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-600 rounded-full transition-all duration-300"
                            style={{ width: `${Math.min(100, Math.round((syncProgress.processed / syncProgress.total) * 100))}%` }}
                          />
                        </div>
                        <span className="tabular-nums font-bold w-16 text-right shrink-0">
                          {syncProgress.processed} / {syncProgress.total}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] font-medium text-amber-700/80 leading-relaxed">
                        Batches of 100 articles, 4 auto-retries each with 1/2/4s backoff if your Wi-Fi drops. If the browser tab is killed, simply re-click Run Sync &amp; Repair — every write is idempotent.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h2>
          <p className="text-slate-500 font-medium text-sm">Platform Metrics & Analytics</p>
        </div>
        <div className="flex items-center gap-4">
          {/* <button
            onClick={handleRepairSequenceNumbers}
            disabled={repairingSeq || syncing}
            className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-amber-200 text-amber-700 font-bold text-xs hover:bg-amber-50 transition-all shadow-sm disabled:opacity-50"
          >
            <ListOrdered size={14} className={repairingSeq ? "animate-spin" : ""} />
            {repairingSeq ? "Repairing Seq..." : "Repair Seq (1-1493)"}
          </button> */}
          <button
            onClick={handleSyncStats}
            disabled={syncing}
            className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50 transition-all shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing..." : "Sync Statistics"}
          </button>
          <input
            ref={seqCsvInputRef}
            type="file"
            accept=".csv"
            onChange={onSeqCsvSelected}
            className="hidden"
          />
          <div className="flex items-center gap-3 bg-white px-5 py-2.5 rounded-xl border border-slate-100 shadow-sm">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">System Live</span>
          </div>
        </div>
      </div>

      {/* Sync progress banner (normal dashboard view) */}
      {syncing && (
        <div className="bg-amber-50 border-2 border-amber-200 p-5 rounded-[32px] shadow-sm shadow-amber-100 animate-in slide-in-from-top-4 duration-500 space-y-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600 shrink-0">
              <Loader2 size={22} className="animate-spin" />
            </div>
            <div className="flex-1 space-y-2">
              <p className="text-sm font-black text-amber-900 uppercase tracking-tight">
                {syncProgress?.step || "Running Sync & Repair…"}
              </p>
              {syncProgress && syncProgress.total > 0 ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2.5 bg-amber-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-amber-400 to-amber-600 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.round((syncProgress.processed / syncProgress.total) * 100))}%` }}
                      />
                    </div>
                    <span className="tabular-nums font-black text-sm text-amber-900 w-20 text-right shrink-0">
                      {syncProgress.processed} / {syncProgress.total}
                    </span>
                  </div>
                  <p className="text-[11px] font-bold text-amber-700/80 leading-relaxed">
                    Batches of 100 articles with 4× auto-retry and exponential backoff. If your internet drops, just click Sync Statistics again — every write is idempotent.
                  </p>
                </>
              ) : (
                <p className="text-[11px] font-bold text-amber-700/80 leading-relaxed">
                  Fetching annotators and articles from Firestore… (first batch usually completes in 2–10 seconds).
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* KPI Grid */}
      {(staleSummary || ((!stats.totalArticles || stats.totalArticles === 0) && stats.inProgressArticles > 0)) && (
        <div className="bg-amber-50 border-2 border-amber-200 p-6 rounded-[32px] flex items-center justify-between gap-6 animate-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600">
              <ShieldAlert size={24} />
            </div>
            <div>
              <p className="text-sm font-black text-amber-900 uppercase tracking-tight">Statistics Out of Sync</p>
              <p className="text-xs font-bold text-amber-600/80">
                {staleSummary
                  ? "The stored summary document has invalid values (e.g. negative counts). Click \"Fix Statistics Now\" to recompute from live data."
                  : "Your dashboard is showing incorrect counts because the summary document hasn't been initialized."
                }
              </p>
            </div>
          </div>
          <button
            onClick={handleSyncStats}
            disabled={syncing}
            className="bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all shadow-lg shadow-amber-200 flex items-center gap-2 shrink-0"
          >
            <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
            Fix Statistics Now
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((card, i) => (
          <div key={i} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-4 hover:shadow-md transition-all group relative overflow-hidden">
            <div className={`${card.color} w-12 h-12 rounded-xl text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform`}>
              <card.icon size={24} />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">{card.label}</p>
              <p className="text-3xl font-bold text-slate-900">{card.value.toLocaleString()}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Category Bar Chart */}
        <div className="bg-white p-10 rounded-[40px] shadow-xl shadow-slate-200/40 border border-slate-50">
          <div className="mb-8">
            <h3 className="text-xl font-black text-slate-900 tracking-tight uppercase">Article Distribution</h3>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Volume by Topic Category</p>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData} margin={{ top: 20, right: 30, left: 20, bottom: 70 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="value" fill="#3b82f6" radius={[6, 6, 0, 0]} barSize={40} label={{ position: 'top', fill: '#64748b', fontSize: 10, fontWeight: 'bold' }}>
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={['#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a'][index % 5]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Status Pie Chart */}
        <div className="bg-white p-10 rounded-[40px] shadow-xl shadow-slate-200/40 border border-slate-50">
          <div className="mb-8">
            <h3 className="text-xl font-black text-slate-900 tracking-tight uppercase">Progress Overview</h3>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Live Annotation Status</p>
          </div>
          <div className="h-80 flex flex-col items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={8}
                  dataKey="value"
                  stroke="none"
                  label={({ name, value }) => value > 0 ? `${name}: ${value}` : ''}
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

    </div>
  );
}
