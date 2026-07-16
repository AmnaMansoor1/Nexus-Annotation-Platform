import { useState, useEffect, useCallback } from "react";
import { doc, getDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { assignArticlesForAnnotator } from "../utils/assignArticles";

export function useArticleAssignment(email: string | null, refreshTrigger = 0) {
  const [assignedArticles, setAssignedArticles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAssignment = useCallback(async () => {
    console.log("[useArticleAssignment] Starting loadAssignment for email:", email);
    if (!email) {
      console.log("[useArticleAssignment] No email provided");
      return;
    }
    
    try {
      setLoading(true);
      const annotatorRef = doc(db, "annotators", email);
      console.log("[useArticleAssignment] Fetching annotator doc from:", annotatorRef.path);
      const annotatorDoc = await getDoc(annotatorRef);
      
      console.log("[useArticleAssignment] Annotator doc exists?", annotatorDoc.exists());
      if (annotatorDoc.exists()) {
        const data = annotatorDoc.data() as Annotator;
        console.log("[useArticleAssignment] Annotator data:", data);
        let currentAssignment = data.assigned_articles || [];
        const completed = data.completed_articles || [];
        
        console.log("[useArticleAssignment] Current assigned articles:", currentAssignment);
        console.log("[useArticleAssignment] Completed articles:", completed);
        
        // Filter out articles that might have been deleted or are invalid
        // (Basic sanitization)
        currentAssignment = currentAssignment.filter(id => id);

        if (currentAssignment.length < 20) {
          // Try to fill the gap
          console.log("[useArticleAssignment] Need more articles, calling assignArticlesForAnnotator");
          const moreArticles = await assignArticlesForAnnotator(email);
          console.log("[useArticleAssignment] Received more articles from assignArticlesForAnnotator:", moreArticles);
          const trulyNew = moreArticles.filter(id => !currentAssignment.includes(id));
          console.log("[useArticleAssignment] Truly new articles to add:", trulyNew);
          
          if (trulyNew.length > 0) {
            const newAssignment = [...currentAssignment, ...trulyNew].slice(0, 20);
            console.log("[useArticleAssignment] Updating annotator doc with new assignment:", newAssignment);
            await updateDoc(annotatorRef, {
              assigned_articles: newAssignment
            });
            setAssignedArticles(newAssignment);
          } else {
            console.log("[useArticleAssignment] No truly new articles, setting current assignment");
            setAssignedArticles(currentAssignment);
          }
        } else {
          console.log("[useArticleAssignment] Already have 20 articles, setting current assignment");
          setAssignedArticles(currentAssignment);
        }
      } else {
        console.warn("[useArticleAssignment] Annotator doc does NOT exist for email:", email);
      }
    } catch (err) {
      console.error("[useArticleAssignment] ERROR:", err);
      setError("Failed to assign articles. Please refresh.");
    } finally {
      setLoading(false);
      console.log("[useArticleAssignment] Finished loadAssignment");
    }
  }, [email]);

  useEffect(() => {
    console.log("[useArticleAssignment] useEffect triggered with email, refreshTrigger:", email, refreshTrigger);
    loadAssignment();
  }, [email, refreshTrigger, loadAssignment]);

  return { assignedArticles, loading, error, loadAssignment };
}
