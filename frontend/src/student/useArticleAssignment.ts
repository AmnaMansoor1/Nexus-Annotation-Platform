import { useState, useEffect, useCallback } from "react";
import { doc, getDoc, updateDoc, arrayUnion, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { assignArticlesForAnnotator } from "../utils/assignArticles";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";

export function useArticleAssignment(email: string | null, refreshTrigger = 0) {
  const [assignedArticles, setAssignedArticles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAssignment = useCallback(async () => {
    console.log("[useArticleAssignment] Starting loadAssignment for email:", email);
    if (!email) {
      console.log("[useArticleAssignment] No email provided");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(email));
      console.log("[useArticleAssignment] Fetching annotator doc from:", annotatorRef.path);

      let annotatorDoc;
      try {
        annotatorDoc = await getDoc(annotatorRef);
      } catch (fetchErr: any) {
        // Firestore rules disallow read of non-existent annotator docs
        // (resourceHasEmail fails when resource == null because there's no
        // `email` field to match against). Treat PERMISSION_DENIED here as
        // "annotator doc missing" and proceed to the Case B creation path.
        const msg = (fetchErr && fetchErr.message) || "";
        const isPerm = (fetchErr && (fetchErr.code === "permission-denied" ||
          fetchErr.code === "firestore/permission-denied")) ||
          /permission|insufficient/i.test(msg);
        if (isPerm) {
          console.warn("[useArticleAssignment] getDoc annotator returned PERMISSION_DENIED — treating as MISSING doc and creating one.");
          annotatorDoc = { exists: () => false } as any;
        } else {
          console.error("[useArticleAssignment] FAILURE fetching annotator doc (security rules / network?):", fetchErr);
          setError("Could not load your profile. Please check permissions and login again.");
          return;
        }
      }

      console.log("[useArticleAssignment] Annotator doc exists?", annotatorDoc.exists());

      let currentAssignment: string[] = [];
      let completed: string[] = [];

      // Case A: Annotator doc exists
      if (annotatorDoc.exists()) {
        const data = annotatorDoc.data() as Annotator;
        console.log("[useArticleAssignment] Annotator data (first assignment):", {
          assigned_articles_count: (data.assigned_articles || []).length,
          completed_articles_count: (data.completed_articles || []).length,
          completed: data.completed
        });
        currentAssignment = Array.isArray(data.assigned_articles) ? data.assigned_articles.filter(Boolean) : [];
        completed = Array.isArray(data.completed_articles) ? data.completed_articles.filter(Boolean) : [];
      } else {
        // Case B: Annotator doc MISSING — create it right here, right now.
        console.warn("[useArticleAssignment] Annotator doc MISSING. Creating now for:", email);
        const newUser: Annotator = {
          email: email,
          full_name: email.split('@')[0],
          completed: false,
          completed_articles: [],
          assigned_articles: [],
          reliability_score: 0,
          gold_total_count: 0,
          gold_correct_count: 0,
          gold_accuracy: 0
        };
        try {
          await setDoc(annotatorRef, newUser);
          console.log("[useArticleAssignment] Created missing annotator doc for", email);
        } catch (createErr) {
          console.error("[useArticleAssignment] FAILED to create missing annotator doc (rules?):", createErr);
          setError("Could not create your profile. Please refresh and try again, or contact admin.");
          return;
        }
        currentAssignment = [];
        completed = [];
      }

      console.log("[useArticleAssignment] Current assigned count:", currentAssignment.length, "Current completed:", completed.length);

      // Only try to assign if we haven't reached 20 assigned yet
      if (currentAssignment.length < 20) {
        console.log("[useArticleAssignment] Need more articles. Calling assignArticlesForAnnotator...");
        let moreArticles: string[] = [];
        try {
          moreArticles = await assignArticlesForAnnotator(email);
        } catch (assignErr) {
          console.error("[useArticleAssignment] assignArticlesForAnnotator THREW EXCEPTION:", assignErr);
          setError("Article assignment failed. Click 'Try Again' to retry.");
        }
        console.log("[useArticleAssignment] assignArticlesForAnnotator returned:", moreArticles.length, "articles:", moreArticles);

        if (moreArticles.length > 0) {
          // Deduplicate against current assignment & completed
          const assignedSet = new Set(currentAssignment);
          const completedSet = new Set(completed);
          const trulyNew: string[] = [];
          for (const id of moreArticles) {
            if (id && !assignedSet.has(id) && !completedSet.has(id)) {
              trulyNew.push(id);
              assignedSet.add(id);
            }
          }
          const mergedAssignment = [...currentAssignment, ...trulyNew].slice(0, 20);
          console.log("[useArticleAssignment] Truly new articles:", trulyNew.length, ". Merged assignment (", mergedAssignment.length, "):", mergedAssignment);

          // ✅ Always save mergedAssignment back to Firestore if something changed
          // (even if trulyNew is empty — maybe articles assigned to user in article docs not yet reflected here)
          const assignmentChanged = mergedAssignment.length !== currentAssignment.length
            || mergedAssignment.some((v, i) => v !== currentAssignment[i]);

          if (assignmentChanged || mergedAssignment.length > 0) {
            try {
              console.log("[useArticleAssignment] Writing merged assignment to annotator doc via setDoc merge...");
              await setDoc(annotatorRef, {
                assigned_articles: mergedAssignment
              } as any, { merge: true });
              console.log("[useArticleAssignment] ✅ SUCCESS: Saved merged assignment to annotator doc.");
            } catch (saveErr) {
              console.error("[useArticleAssignment] ❌ FAILED to save assigned_articles to annotator doc! (security rules?):", saveErr);
              setError("Saved your assigned articles locally but couldn't save to server. Contact admin to check Firestore write rules for /annotators.");
            }
          }
          setAssignedArticles(mergedAssignment);
        } else {
          // assignArticles returned [] — keep what we have. 
          console.log("[useArticleAssignment] assignArticles returned empty list. Keeping current assignment:", currentAssignment);
          if (currentAssignment.length > 0) {
            setAssignedArticles(currentAssignment);
          } else {
            setAssignedArticles([]);
            setError("No articles could be assigned. Make sure articles exist in Firestore with status=pending.");
          }
        }
      } else {
        // Already >= 20 articles assigned.
        console.log("[useArticleAssignment] Already have", currentAssignment.length, "articles (> 20). Not fetching more.");
        setAssignedArticles(currentAssignment);
      }

    } catch (err) {
      console.error("[useArticleAssignment] UNEXPECTED TOP-LEVEL ERROR:", err);
      setError("Failed to assign articles: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      console.log("[useArticleAssignment] Finished loadAssignment");
    }
  }, [email]);

  useEffect(() => {
    console.log("[useArticleAssignment] useEffect triggered with email=", email, "refreshTrigger=", refreshTrigger);
    loadAssignment();
  }, [email, refreshTrigger, loadAssignment]);

  return { assignedArticles, loading, error, loadAssignment };
}
