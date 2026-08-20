import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";
import { getRequiredAnnotations } from "./annotationConfig";

const randomDelay = (min: number = 100, max: number = 1000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

function normalizeArticle(data: any): Article {
  const statusVal = data?.status;
  const assignedCountVal = data?.assigned_count;
  const annotationCountVal = data?.annotation_count;
  return {
    ...(data || {}),
    assigned_to: Array.isArray(data?.assigned_to) ? data.assigned_to : [],
    annotated_by: Array.isArray(data?.annotated_by) ? data.annotated_by : [],
    is_gold_standard: !!data?.is_gold_standard,
    assigned_count: typeof assignedCountVal === "number" ? assignedCountVal : 0,
    annotation_count: typeof annotationCountVal === "number" ? annotationCountVal : 0,
    status: (statusVal === "pending" || statusVal === "partial" || statusVal === "complete") ? statusVal : "pending",
  } as Article;
}

export function isEligible(article: Article, email: string, requiredAnnotations: number): { ok: boolean; reason?: string } {
  const okStatus = article.status === "pending" || article.status === "partial";
  if (!okStatus) return { ok: false, reason: `status=${article.status}` };

  if (article.annotation_count >= requiredAnnotations && article.status !== "complete") {
    return { ok: false, reason: `consistency-err: status=${article.status} but annotation_count=${article.annotation_count}>=${requiredAnnotations}` };
  }
  if (article.status === "partial" && article.annotation_count === 0) {
    return { ok: false, reason: `consistency-err: status=partial but annotation_count=0` };
  }
  if (article.status === "pending" && article.annotation_count > 0) {
    return { ok: false, reason: `consistency-err: status=pending but annotation_count=${article.annotation_count}>0` };
  }

  if (article.assigned_count >= requiredAnnotations) return { ok: false, reason: `assigned_count=${article.assigned_count}>=${requiredAnnotations}` };
  if (article.assigned_to.includes(email)) return { ok: false, reason: "already-assigned-to-me" };

  return { ok: true };
}

export interface SequentialSelectionResult {
  selected: string[];
  skipped_inconsistent: string[];
}

export function selectArticlesSequentially(
  articles: Article[],
  email: string,
  requiredAnnotations: number,
  maxToSelect: number
): SequentialSelectionResult {
  const skipped_inconsistent: string[] = [];
  const eligible: Article[] = [];

  const sorted = [...articles].sort(
    (a, b) => ((a as any).sequence_number ?? 0) - ((b as any).sequence_number ?? 0)
  );

  for (const article of sorted) {
    const check = isEligible(article, email, requiredAnnotations);
    if (!check.ok) {
      if (check.reason?.startsWith("consistency-err")) {
        skipped_inconsistent.push(article.article_id);
      }
      continue;
    }
    eligible.push(article);
    if (eligible.length >= maxToSelect * 2) break;
  }

  const selected = eligible.slice(0, maxToSelect).map(a => a.article_id);
  return { selected, skipped_inconsistent };
}

export async function assignArticlesForAnnotator(email: string): Promise<string[]> {
  console.log("[assignArticlesForAnnotator] Starting for email:", email);
  await randomDelay(100, 500);

  let adminConfig: AdminConfig | null = null;
  try {
    console.log("[assignArticlesForAnnotator] Fetching admin_config/settings");
    const adminDoc = await getDoc(doc(db, "admin_config", "settings"));
    if (adminDoc.exists()) {
      adminConfig = adminDoc.data() as AdminConfig;
    }
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Could not load admin settings, proceeding with defaults.", err);
  }

  const articlesRef = collection(db, "articles");
  let eligibleArticles: Article[] = [];

  // ─────────────────────────────────────────────────────────────────
  // STRATEGY A (PRIMARY) — uses composite index:
  //   articles: status ASC, sequence_number ASC
  // Query: where(status in [pending, partial]) + orderBy(sequence_number ASC)
  // NEVER uses article_id for ordering.
  // Defensive: limit(100) so we have candidates even after filtering.
  // ─────────────────────────────────────────────────────────────────
  try {
    console.log("[assignArticlesForAnnotator] Running Strategy A (composite index: status + sequence_number)");
    const strategyAQ = query(
      articlesRef,
      where("status", "in", ["pending", "partial"]),
      orderBy("sequence_number", "asc"),
      limit(100)
    );
    const strategyASnap = await getDocs(strategyAQ);
    console.log("[assignArticlesForAnnotator] Strategy A returned", strategyASnap.size, "docs");

    const inconsistencies: string[] = [];
    const candidates: Article[] = [];
    for (const docSnap of strategyASnap.docs) {
      const article = normalizeArticle(docSnap.data());
      const requiredAnnotations = getRequiredAnnotations(article, adminConfig);
      const check = isEligible(article, email, requiredAnnotations);
      if (!check.ok) {
        if (check.reason?.startsWith("consistency-err")) {
          inconsistencies.push(`${article.article_id}(seq=${(article as any).sequence_number}): ${check.reason}`);
        }
        continue;
      }
      candidates.push(article);
    }

    if (inconsistencies.length > 0) {
      console.warn("[assignArticlesForAnnotator] Strategy A skipped", inconsistencies.length, "inconsistent articles:", inconsistencies.slice(0, 5));
    }

    candidates.sort((a, b) => ((a as any).sequence_number ?? 0) - ((b as any).sequence_number ?? 0));
    eligibleArticles = candidates.slice(0, 20);
    console.log("[assignArticlesForAnnotator] Strategy A eligible after filter:", eligibleArticles.length, "/", candidates.length, "candidates");
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Strategy A failed (index missing?):", err);
  }

  // ─────────────────────────────────────────────────────────────────
  // STRATEGY B (FALLBACK) — no composite index required
  // orderBy(sequence_number, asc) + limit(500). Filter client-side.
  // NEVER falls back to article_id/doc-name ordering.
  // ─────────────────────────────────────────────────────────────────
  if (eligibleArticles.length < 20) {
    try {
      console.log("[assignArticlesForAnnotator] Running Strategy B (fallback: sequence_number order, client-side filter)");
      const fallbackQ = query(articlesRef, orderBy("sequence_number", "asc"), limit(500));
      const fallbackSnap = await getDocs(fallbackQ);
      console.log("[assignArticlesForAnnotator] Strategy B returned", fallbackSnap.size, "docs");

      const alreadySeen = new Set(eligibleArticles.map(a => a.article_id));
      const inconsistencies: string[] = [];
      for (const docSnap of fallbackSnap.docs) {
        if (eligibleArticles.length >= 20) break;
        const data = docSnap.data();
        if (alreadySeen.has(data.article_id)) continue;
        const article = normalizeArticle(data);
        const requiredAnnotations = getRequiredAnnotations(article, adminConfig);
        const check = isEligible(article, email, requiredAnnotations);
        if (!check.ok) {
          if (check.reason?.startsWith("consistency-err")) {
            inconsistencies.push(`${article.article_id}(seq=${(article as any).sequence_number}): ${check.reason}`);
          }
          continue;
        }
        eligibleArticles.push(article);
        alreadySeen.add(article.article_id);
      }

      if (inconsistencies.length > 0) {
        console.warn("[assignArticlesForAnnotator] Strategy B skipped", inconsistencies.length, "inconsistent articles");
      }
      console.log("[assignArticlesForAnnotator] Strategy B total eligible now:", eligibleArticles.length);
    } catch (err2) {
      console.warn("[assignArticlesForAnnotator] Strategy B also failed:", err2);
    }
  }

  console.log("[assignArticlesForAnnotator] Total eligible articles found:", eligibleArticles.length);
  if (eligibleArticles.length === 0) {
    console.warn("[assignArticlesForAnnotator] ❌ NO ELIGIBLE ARTICLES FOUND. Check: 1) Do articles exist? 2) Do they have status=pending/partial? 3) assigned_count<required_annotations? 4) Not already assigned to this user?");
    return [];
  }

  eligibleArticles.sort((a, b) => ((a as any).sequence_number ?? 0) - ((b as any).sequence_number ?? 0));
  const selectedArticles = eligibleArticles.slice(0, 20);
  const selectedIds = selectedArticles.map(a => a.article_id);
  console.log("[assignArticlesForAnnotator] Selected article IDs (sequential by sequence_number,", selectedIds.length, "):", selectedIds.map((id, i) => `${id}#seq=${(selectedArticles[i] as any).sequence_number}`).join(", "));

  const finalAssignment = [...selectedIds];
  console.log("[assignArticlesForAnnotator] Final assignment (", finalAssignment.length, "articles):", finalAssignment);

  if (selectedIds.length > 0) {
    try {
      console.log("[assignArticlesForAnnotator] Starting article assignment writes for", selectedIds.length, "articles");
      const batch = writeBatch(db);
      let batchCount = 0;
      const MAX_BATCH_SIZE = 500;

      for (const articleId of selectedIds) {
        if (batchCount >= MAX_BATCH_SIZE - 10) {
          console.log("[assignArticlesForAnnotator] Committing intermediate batch with", batchCount, "writes");
          await batch.commit();
          batchCount = 0;
        }
        const articleRef = doc(db, "articles", articleId);
        batch.set(articleRef, {
          assigned_count: increment(1),
          assigned_to: arrayUnion(email)
        }, { merge: true });
        batchCount += 1;
      }

      if (batchCount > 0) {
        console.log("[assignArticlesForAnnotator] Committing final batch with", batchCount, "writes");
        await batch.commit();
        console.log("[assignArticlesForAnnotator] ✅ Batch write SUCCESSFUL!");
      }
    } catch (e) {
      console.error("[assignArticlesForAnnotator] ❌ Batch write FAILED:", e);
      let successCount = 0;
      const successfulIds: string[] = [];
      for (const articleId of selectedIds) {
        try {
          const articleRef = doc(db, "articles", articleId);
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(articleRef);
            if (!snap.exists()) return;
            const current = snap.data() as Article;
            const currentAssignedTo = Array.isArray(current.assigned_to) ? current.assigned_to : [];
            const currentAssignedCount = typeof (current as any).assigned_count === "number" ? (current as any).assigned_count : 0;
            tx.set(articleRef, {
              assigned_count: currentAssignedCount + 1,
              assigned_to: Array.from(new Set([...currentAssignedTo, email]))
            }, { merge: true });
          });
          successfulIds.push(articleId);
          successCount++;
        } catch (perr) {
          console.warn("[assignArticlesForAnnotator] Single-article write failed for", articleId, ":", perr);
        }
      }
      console.log("[assignArticlesForAnnotator] Fallback individually wrote", successCount, "/", selectedIds.length, "articles");
      console.log("[assignArticlesForAnnotator] Returning fallback assignment:", successfulIds);
      return successfulIds;
    }
  }

  console.log("[assignArticlesForAnnotator] ✅ DONE. Returning finalAssignment:", finalAssignment);
  return finalAssignment;
}
