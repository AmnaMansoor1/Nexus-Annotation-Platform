import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";

// Add random jitter to spread out requests
const randomDelay = (min: number = 100, max: number = 1000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

export async function assignArticlesForAnnotator(email: string): Promise<string[]> {
  // 0. Add initial jitter to avoid thundering herd
  await randomDelay(100, 500);
  
  // 1. Get Admin Config for gold standard IDs
  let goldIds: string[] = [];
  try {
    const adminDoc = await getDoc(doc(db, "admin_config", "settings"));
    if (adminDoc.exists()) {
      const adminConfig = adminDoc.data() as AdminConfig;
      goldIds = adminConfig.gold_article_ids || [];
    }
  } catch (err) {
    console.warn("Could not load admin settings, proceeding without gold standards.");
  }
  
  // 2. Query eligible articles efficiently
  const articlesRef = collection(db, "articles");
  let eligibleArticles: Article[] = [];

  try {
    // Try to get a random slice by using different orderings
    const randomSort = Math.random() > 0.5 ? "article_id" : "date_published";
    const q = query(
      articlesRef, 
      where("status", "in", ["pending", "partial"]),
      where("assigned_count", "<", 10),
      orderBy(randomSort),
      limit(200) // Fetch more to increase chances of finding unassigned articles
    );
    
    const querySnapshot = await getDocs(q);
    eligibleArticles = querySnapshot.docs
      .map(doc => doc.data() as Article)
      .filter(article => !article.assigned_to.includes(email) && !article.is_gold_standard);
  } catch (err) {
    console.warn("Optimized query failed, falling back to broader search:", err);
    // Fallback: Broad query
    const fallbackQ = query(
      articlesRef,
      where("status", "in", ["pending", "partial"]),
      limit(200)
    );
    const fallbackSnapshot = await getDocs(fallbackQ);
    eligibleArticles = fallbackSnapshot.docs
      .map(doc => doc.data() as Article)
      .filter(article => !article.assigned_to.includes(email) && !article.is_gold_standard);
  }

  // 3. Randomly select articles
  const shuffled = eligibleArticles.sort(() => 0.5 - Math.random());
  const selectedArticles = shuffled.slice(0, 18);
  const selectedIds = selectedArticles.map(a => a.article_id);

  // 4. Inject gold standard articles
  let selectedGold: string[] = [];
  if (goldIds.length > 0) {
    selectedGold = goldIds.sort(() => 0.5 - Math.random()).slice(0, 2);
  }
  
  const finalAssignment = Array.from(new Set([...selectedIds, ...selectedGold]));
  
  if (finalAssignment.length === 0) {
    console.warn("No eligible articles found for user:", email);
    return [];
  }

  // 5. Update assignments - use a batched write instead of a single transaction for better throughput
  if (selectedIds.length > 0) {
    try {
      const batch = writeBatch(db);
      let batchCount = 0;
      const MAX_BATCH_SIZE = 500; // Firestore limit is 500 writes per batch

      for (const articleId of selectedIds) {
        if (batchCount >= MAX_BATCH_SIZE - 10) {
          await batch.commit();
          batchCount = 0;
        }
        
        const articleRef = doc(db, "articles", articleId);
        batch.update(articleRef, {
          assigned_count: increment(1),
          assigned_to: arrayUnion(email)
        });
        batchCount += 1;
      }
      
      if (batchCount > 0) {
        await batch.commit();
      }
    } catch (e) {
      console.error("Failed to update article assignments in batch:", e);
      
      // Fallback to a smaller batch if the first one fails
      try {
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
        console.error("Fallback also failed:", fallbackErr);
        return selectedGold; // At least return the gold articles
      }
    }
  }

  return finalAssignment;
}
