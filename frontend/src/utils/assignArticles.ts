import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion, writeBatch, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";

const randomDelay = (min: number = 100, max: number = 1000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

export async function assignArticlesForAnnotator(email: string): Promise<string[]> {
  console.log("[assignArticlesForAnnotator] Starting for email:", email);
  await randomDelay(100, 500);

  let goldIds: string[] = [];
  try {
    console.log("[assignArticlesForAnnotator] Fetching admin_config/settings");
    const adminDoc = await getDoc(doc(db, "admin_config", "settings"));
    if (adminDoc.exists()) {
      const adminConfig = adminDoc.data() as AdminConfig;
      goldIds = adminConfig.gold_article_ids || [];
      console.log("[assignArticlesForAnnotator] Gold article IDs from config:", goldIds);
    }
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Could not load admin settings, proceeding without gold standards.", err);
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
        const notFull = article.assigned_count < 10;
        const notAssigned = !article.assigned_to.includes(email);
        const notGold = !article.is_gold_standard;
        const ok = okStatus && notFull && notAssigned && notGold;
        console.log("[assignArticlesForAnnotator] Article", article.article_id, "status=", article.status, "count=", article.assigned_count, "assigned_to_me=", article.assigned_to.includes(email), "gold=", article.is_gold_standard, "=> ELIGIBLE:", ok);
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
        .filter(article => article.assigned_count < 10 && !article.assigned_to.includes(email) && !article.is_gold_standard);
      console.log("[assignArticlesForAnnotator] Strategy 2 eligible articles:", eligibleArticles.length);
    } catch (err2) {
      console.warn("[assignArticlesForAnnotator] Strategy 2 also failed:", err2);
    }
  }

  // 3. Randomly select
  console.log("[assignArticlesForAnnotator] Total eligible articles found:", eligibleArticles.length);
  if (eligibleArticles.length === 0) {
    console.warn("[assignArticlesForAnnotator] ❌ NO ELIGIBLE ARTICLES FOUND. Check: 1) Do articles exist? 2) Do they have status=pending/partial? 3) assigned_count<10? 4) Not already assigned to this user?");
    return [];
  }

  const shuffled = eligibleArticles.sort(() => 0.5 - Math.random());
  const selectedArticles = shuffled.slice(0, 18);
  const selectedIds = selectedArticles.map(a => a.article_id);
  console.log("[assignArticlesForAnnotator] Selected regular article IDs:", selectedIds);

  let selectedGold: string[] = [];
  if (goldIds.length > 0) {
    selectedGold = goldIds.sort(() => 0.5 - Math.random()).slice(0, 2);
    console.log("[assignArticlesForAnnotator] Selected gold article IDs:", selectedGold);
  }

  const finalAssignment = Array.from(new Set([...selectedIds, ...selectedGold]));
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
      for (const articleId of selectedIds.slice(0, 10)) {
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
      console.log("[assignArticlesForAnnotator] Fallback individually wrote", successCount, "/", selectedIds.slice(0, 10).length, "articles");
      const fallbackAssignment = Array.from(new Set([...successfulIds, ...selectedGold]));
      console.log("[assignArticlesForAnnotator] Returning fallback assignment:", fallbackAssignment);
      return fallbackAssignment;
    }
  }

  console.log("[assignArticlesForAnnotator] ✅ DONE. Returning finalAssignment:", finalAssignment);
  return finalAssignment;
}
