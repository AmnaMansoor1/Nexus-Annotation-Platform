import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";

// Add random jitter to spread out requests
const randomDelay = (min: number = 100, max: number = 1000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

export async function assignArticlesForAnnotator(email: string): Promise<string[]> {
  console.log("[assignArticlesForAnnotator] Starting for email:", email);
  // 0. Add initial jitter to avoid thundering herd
  await randomDelay(100, 500);
  
  // 1. Get Admin Config for gold standard IDs
  let goldIds: string[] = [];
  try {
    console.log("[assignArticlesForAnnotator] Fetching admin_config/settings");
    const adminDoc = await getDoc(doc(db, "admin_config", "settings"));
    console.log("[assignArticlesForAnnotator] Admin config exists?", adminDoc.exists());
    if (adminDoc.exists()) {
      const adminConfig = adminDoc.data() as AdminConfig;
      goldIds = adminConfig.gold_article_ids || [];
      console.log("[assignArticlesForAnnotator] Gold article IDs from config:", goldIds);
    }
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Could not load admin settings, proceeding without gold standards.", err);
  }
  
  // 2. Query eligible articles efficiently
  const articlesRef = collection(db, "articles");
  let eligibleArticles: Article[] = [];

  try {
    // Try to get a random slice by using different orderings
    const randomSort = Math.random() > 0.5 ? "article_id" : "date_published";
    console.log("[assignArticlesForAnnotator] Running optimized query with sort:", randomSort);
    const q = query(
      articlesRef, 
      where("status", "in", ["pending", "partial"]),
      where("assigned_count", "<", 10),
      orderBy(randomSort),
      limit(200) // Fetch more to increase chances of finding unassigned articles
    );
    
    console.log("[assignArticlesForAnnotator] Executing query...");
    const querySnapshot = await getDocs(q);
    console.log("[assignArticlesForAnnotator] Query returned", querySnapshot.size, "docs");
    eligibleArticles = querySnapshot.docs
      .map(doc => {
        const data = doc.data() as Article;
        console.log("[assignArticlesForAnnotator] Article doc data:", { id: doc.id, ...data });
        // Ensure all required fields exist with defaults
        const safeArticle: Article = {
          ...data,
          assigned_to: data.assigned_to || [],
          is_gold_standard: data.is_gold_standard || false,
          assigned_count: data.assigned_count || 0,
          status: data.status || "pending"
        };
        return safeArticle;
      })
      .filter(article => {
        const notAssigned = !article.assigned_to.includes(email);
        const notGold = !article.is_gold_standard;
        console.log("[assignArticlesForAnnotator] Filtering article", article.article_id, "notAssigned:", notAssigned, "notGold:", notGold);
        return notAssigned && notGold;
      });
    console.log("[assignArticlesForAnnotator] Eligible articles after filter:", eligibleArticles.length);
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Optimized query failed, falling back to broader search:", err);
    // Fallback: Broad query
    console.log("[assignArticlesForAnnotator] Running fallback broad query");
    const fallbackQ = query(
      articlesRef,
      where("status", "in", ["pending", "partial"]),
      limit(200)
    );
    const fallbackSnapshot = await getDocs(fallbackQ);
    console.log("[assignArticlesForAnnotator] Fallback query returned", fallbackSnapshot.size, "docs");
    eligibleArticles = fallbackSnapshot.docs
      .map(doc => {
        const data = doc.data() as Article;
        // Ensure all required fields exist with defaults
        const safeArticle: Article = {
          ...data,
          assigned_to: data.assigned_to || [],
          is_gold_standard: data.is_gold_standard || false,
          assigned_count: data.assigned_count || 0,
          status: data.status || "pending"
        };
        return safeArticle;
      })
      .filter(article => !article.assigned_to.includes(email) && !article.is_gold_standard);
    console.log("[assignArticlesForAnnotator] Eligible articles after fallback filter:", eligibleArticles.length);
  }

  // 3. Randomly select articles
  console.log("[assignArticlesForAnnotator] Shuffling", eligibleArticles.length, "articles");
  const shuffled = eligibleArticles.sort(() => 0.5 - Math.random());
  const selectedArticles = shuffled.slice(0, 18);
  const selectedIds = selectedArticles.map(a => a.article_id);
  console.log("[assignArticlesForAnnotator] Selected article IDs:", selectedIds);

  // 4. Inject gold standard articles
  let selectedGold: string[] = [];
  if (goldIds.length > 0) {
    selectedGold = goldIds.sort(() => 0.5 - Math.random()).slice(0, 2);
    console.log("[assignArticlesForAnnotator] Selected gold article IDs:", selectedGold);
  }
  
  const finalAssignment = Array.from(new Set([...selectedIds, ...selectedGold]));
  console.log("[assignArticlesForAnnotator] Final assignment:", finalAssignment);
  
  if (finalAssignment.length === 0) {
    console.warn("[assignArticlesForAnnotator] No eligible articles found for user:", email);
    return [];
  }

  // 5. Update assignments - use a batched write instead of a single transaction for better throughput
  if (selectedIds.length > 0) {
    try {
      console.log("[assignArticlesForAnnotator] Starting batch write for", selectedIds.length, "articles");
      const batch = writeBatch(db);
      let batchCount = 0;
      const MAX_BATCH_SIZE = 500; // Firestore limit is 500 writes per batch

      for (const articleId of selectedIds) {
        if (batchCount >= MAX_BATCH_SIZE - 10) {
          console.log("[assignArticlesForAnnotator] Committing intermediate batch with", batchCount, "writes");
          await batch.commit();
          batchCount = 0;
        }
        
        const articleRef = doc(db, "articles", articleId);
        console.log("[assignArticlesForAnnotator] Adding update to batch for article:", articleId);
        batch.update(articleRef, {
          assigned_count: increment(1),
          assigned_to: arrayUnion(email)
        });
        batchCount += 1;
      }
      
      if (batchCount > 0) {
        console.log("[assignArticlesForAnnotator] Committing final batch with", batchCount, "writes");
        await batch.commit();
      }
    } catch (e) {
      console.error("[assignArticlesForAnnotator] Failed to update article assignments in batch:", e);
      
      // Fallback to a smaller batch if the first one fails
      try {
        console.log("[assignArticlesForAnnotator] Trying small batch fallback");
        const smallBatch = writeBatch(db);
        for (const articleId of selectedIds.slice(0, 5)) {
          const articleRef = doc(db, "articles", articleId);
          smallBatch.update(articleRef, {
            assigned_count: increment(1),
            assigned_to: arrayUnion(email)
          });
        }
        await smallBatch.commit();
        return finalAssignment.slice(0, 5 + selectedGold.length);
      } catch (fallbackErr) {
        console.error("[assignArticlesForAnnotator] Fallback also failed:", fallbackErr);
        return selectedGold; // At least return the gold articles
      }
    }
  }

  console.log("[assignArticlesForAnnotator] Returning final assignment:", finalAssignment);
  return finalAssignment;
}
