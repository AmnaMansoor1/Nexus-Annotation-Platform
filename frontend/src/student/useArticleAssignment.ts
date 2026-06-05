import { useState, useEffect } from "react";
import { doc, getDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { assignArticlesForAnnotator } from "../utils/assignArticles";

export function useArticleAssignment(email: string | null) {
  const [assignedArticles, setAssignedArticles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function initAssignment() {
      if (!email) return;
      
      try {
        const annotatorRef = doc(db, "annotators", email);
        const annotatorDoc = await getDoc(annotatorRef);
        
        if (annotatorDoc.exists()) {
          const data = annotatorDoc.data() as Annotator;
          let currentAssignment = data.assigned_articles || [];
          const completed = data.completed_articles || [];
          
          // Filter out articles that might have been deleted or are invalid
          // (Basic sanitization)
          currentAssignment = currentAssignment.filter(id => id);

          if (currentAssignment.length < 20) {
            // Try to fill the gap
            const moreArticles = await assignArticlesForAnnotator(email);
            const trulyNew = moreArticles.filter(id => !currentAssignment.includes(id));
            
            if (trulyNew.length > 0) {
              const newAssignment = [...currentAssignment, ...trulyNew].slice(0, 20);
              await updateDoc(annotatorRef, {
                assigned_articles: newAssignment
              });
              setAssignedArticles(newAssignment);
            } else {
              setAssignedArticles(currentAssignment);
            }
          } else {
            setAssignedArticles(currentAssignment);
          }
        }
      } catch (err) {
        console.error("Assignment error:", err);
        setError("Failed to assign articles. Please refresh.");
      } finally {
        setLoading(false);
      }
    }

    initAssignment();
  }, [email]);

  return { assignedArticles, loading, error };
}
