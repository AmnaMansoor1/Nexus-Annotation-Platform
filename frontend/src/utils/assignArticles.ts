import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";

export async function assignArticlesForAnnotator(email: string): Promise<string[]> {
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
  // We fetch a pool of 40 potential articles to allow for some randomness
  const articlesRef = collection(db, "articles");
  let eligibleArticles: Article[] = [];

  try {
    const q = query(
      articlesRef, 
      where("status", "in", ["pending", "partial"]),
      where("assigned_count", "<", 10),
      limit(100)
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

  // 3. Randomly select articles to fill the gap
  // The caller will slice this to 20, but we provide a healthy pool here
  const shuffled = eligibleArticles.sort(() => 0.5 - Math.random());
  const selectedArticles = shuffled.slice(0, 18);
  const selectedIds = selectedArticles.map(a => a.article_id);

  // 4. Inject gold standard articles if available
  // If we don't have enough regular articles, we might need more gold checks
  let selectedGold: string[] = [];
  if (goldIds.length > 0) {
    selectedGold = goldIds.sort(() => 0.5 - Math.random()).slice(0, 2);
  }
  
  const finalAssignment = Array.from(new Set([...selectedIds, ...selectedGold]));
  
  if (finalAssignment.length === 0) {
    console.warn("No eligible articles found for user:", email);
    return [];
  }

  // 5. Atomic Update: Increment assigned_count and add to assigned_to in a SINGLE transaction
  if (selectedIds.length > 0) {
    try {
      await runTransaction(db, async (transaction) => {
        for (const articleId of selectedIds) {
          const articleRef = doc(db, "articles", articleId);
          const snap = await transaction.get(articleRef);
          if (!snap.exists()) continue;
          
          const data = snap.data() as Article;
          if (!data.assigned_to.includes(email)) {
            transaction.update(articleRef, {
              assigned_count: increment(1),
              assigned_to: arrayUnion(email)
            });
          }
        }
      });
    } catch (e) {
      console.error("Failed to update article assignments in transaction:", e);
    }
  }

  return finalAssignment;
}
