import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion, writeBatch, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";
import { getRequiredAnnotations } from "./annotationConfig";

const randomDelay = (min: number = 100, max: number = 1000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

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

  // Strategy 1: Ultra-simple query with NO composite index requirement (just limit)
  // Works even if no composite indexes deployed at all. Filters client-side by EVERYTHING.
  // Trade-off: fetches more docs, but guarantees results when articles exist.
  try {
    console.log("[assignArticlesForAnnotator] Running Strategy 1: simple scan (no composite index needed)");
    const simpleQ = query(articlesRef, limit(500));
    const simpleSnap = await getDocs(simpleQ);
    console.log("[assignArticlesForAnnotator] Strategy 1 returned", simpleSnap.size, "docs");
    eligibleArticles = simpleSnap.docs
      .map(docSnap => {
        const data = docSnap.data() as Article;
        const statusVal = (data as any).status;
        const assignedCountVal = (data as any).assigned_count;
        return {
          ...data,
          assigned_to: Array.isArray(data.assigned_to) ? data.assigned_to : [],
          is_gold_standard: !!data.is_gold_standard,
          assigned_count: typeof assignedCountVal === "number" ? assignedCountVal : 0,
          status: (statusVal === "pending" || statusVal === "partial" || statusVal === "complete") ? statusVal : "pending"
        } as Article;
      })
      .filter(article => {
        const okStatus = article.status === "pending" || article.status === "partial";
        const requiredAnnotations = getRequiredAnnotations(article, adminConfig);
        const notFull = article.assigned_count < requiredAnnotations;
        const notAssigned = !article.assigned_to.includes(email);
        const ok = okStatus && notFull && notAssigned;
        console.log("[assignArticlesForAnnotator] Article", article.article_id, "status=", article.status, "count=", article.assigned_count, "required=", requiredAnnotations, "assigned_to_me=", article.assigned_to.includes(email), "=> ELIGIBLE:", ok);
        return ok;
      });
    console.log("[assignArticlesForAnnotator] Strategy 1 eligible articles:", eligibleArticles.length);
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Strategy 1 failed:", err);
  }

  // Strategy 2: If Strategy 1 returned 0 (or failed), try status-based query as last-ditch
  if (eligibleArticles.length === 0) {
    try {
      console.log("[assignArticlesForAnnotator] Running Strategy 2: status-only filter");
      const statusQ = query(
        articlesRef,
        where("status", "in", ["pending", "partial"]),
        limit(500)
      );
      const statusSnap = await getDocs(statusQ);
      console.log("[assignArticlesForAnnotator] Strategy 2 returned", statusSnap.size, "docs");
      eligibleArticles = statusSnap.docs
        .map(docSnap => {
          const data = docSnap.data() as Article;
          return {
            ...data,
            assigned_to: Array.isArray(data.assigned_to) ? data.assigned_to : [],
            is_gold_standard: !!data.is_gold_standard,
            assigned_count: typeof (data as any).assigned_count === "number" ? (data as any).assigned_count : 0,
            status: ((data as any).status === "pending" || (data as any).status === "partial") ? (data as any).status : "pending"
          } as Article;
        })
        .filter(article => {
          const requiredAnnotations = getRequiredAnnotations(article, adminConfig);
          return article.assigned_count < requiredAnnotations && !article.assigned_to.includes(email);
        });
      console.log("[assignArticlesForAnnotator] Strategy 2 eligible articles:", eligibleArticles.length);
    } catch (err2) {
      console.warn("[assignArticlesForAnnotator] Strategy 2 also failed:", err2);
    }
  }

  // 3. STRICT BATCH FILLING — sort ALL articles by article_id. Group into batches
  //    of 20. Find the FIRST batch that still has incomplete articles (any
  //    article with assigned_count < required). Only assign articles from THAT
  //    batch. Never skip to a later batch until the current batch is 100% full.
  console.log("[assignArticlesForAnnotator] Total eligible articles found:", eligibleArticles.length);
  if (eligibleArticles.length === 0) {
    console.warn("[assignArticlesForAnnotator] ❌ NO ELIGIBLE ARTICLES FOUND. Check: 1) Do articles exist? 2) Do they have status=pending/partial? 3) assigned_count<required_annotations? 4) Not already assigned to this user?");
    return [];
  }

  // Sort eligible by numeric article_id ascending
  const sorted = [...eligibleArticles].sort((a, b) => {
    const numA = parseFloat(a.article_id);
    const numB = parseFloat(b.article_id);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.article_id.localeCompare(b.article_id);
  });

  const BATCH_SIZE = 20;

  // Determine batch boundaries using each article's numeric id:
  //   batch_idx = floor((numeric_id - 1) / BATCH_SIZE)
  // So ids 1..20 → batch 0, ids 21..40 → batch 1, etc.
  // If id is non-numeric, fall back to positional order in the sorted list.
  const articleWithBatch = sorted.map((article, pos) => {
    const numId = parseFloat(article.article_id);
    let batchIdx = 0;
    if (!isNaN(numId) && numId > 0) {
      batchIdx = Math.floor((numId - 1) / BATCH_SIZE);
    } else {
      batchIdx = Math.floor(pos / BATCH_SIZE);
    }
    return { article, batchIdx };
  });

  // Group eligible articles by batch
  const byBatch = new Map<number, { article: Article; batchIdx: number }[]>();
  for (const item of articleWithBatch) {
    if (!byBatch.has(item.batchIdx)) byBatch.set(item.batchIdx, []);
    byBatch.get(item.batchIdx)!.push(item);
  }

  // Find the EARLIEST (lowest-index) batch that still has eligible articles.
  // Because articles are sorted globally by id, any batch that still needs
  // annotators will appear earlier than later batches — and we must fill it
  // completely before moving on.
  const sortedBatchIndices = Array.from(byBatch.keys()).sort((a, b) => a - b);
  const activeBatchIdx = sortedBatchIndices[0];
  const activeBatchItems = byBatch.get(activeBatchIdx) || [];
  const idRangeStart = activeBatchIdx * BATCH_SIZE + 1;
  const idRangeEnd = (activeBatchIdx + 1) * BATCH_SIZE;
  console.log(
    `[assignArticlesForAnnotator] STRICT BATCH MODE — Active batch #${activeBatchIdx + 1} (ids ${idRangeStart}-${idRangeEnd}).`,
    "Eligible in this batch:",
    activeBatchItems.length,
    "Later batches skipped until this batch is 100% full."
  );

  const selectedArticles = activeBatchItems.map(x => x.article).slice(0, BATCH_SIZE);
  const selectedIds = selectedArticles.map(a => a.article_id);
  console.log(
    `[assignArticlesForAnnotator] Selected ${selectedIds.length} article IDs from active batch #${activeBatchIdx + 1}:`,
    selectedIds
  );

  const finalAssignment = [...selectedIds];
  console.log("[assignArticlesForAnnotator] Final assignment (", finalAssignment.length, "articles):", finalAssignment);

  // 5. Update articles assignments — use setDoc with merge:true (NOT update) to ensure writes
  // succeed even if assigned_count/assigned_to fields don't exist on the document yet.
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

        // ✅ CRITICAL FIX: Use setDoc with {merge: true} inside batch via batch.set
        // Works even if fields/document don't exist yet (unlike batch.update which throws on missing docs/fields)
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
      // Fallback: try individual transactions one by one with setDoc merge + increment
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
