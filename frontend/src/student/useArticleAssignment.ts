import { useState, useEffect, useCallback } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { assignArticlesForAnnotator } from "../utils/assignArticles";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";

const CACHE_KEY_PREFIX = "nexus_assignment_cache_v1_";

interface AssignmentCache {
  email: string;
  assigned_articles: string[];
  completed_articles: string[];
  cachedAt: number;
}

function getCacheKey(email: string): string {
  return CACHE_KEY_PREFIX + sanitizeEmailForDocId(email);
}

function readCache(email: string): AssignmentCache | null {
  try {
    const raw = localStorage.getItem(getCacheKey(email));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.email !== email) return null;
    if (!Array.isArray(parsed.assigned_articles)) return null;
    if (!Array.isArray(parsed.completed_articles)) return null;
    return parsed as AssignmentCache;
  } catch (e) {
    console.warn("[useArticleAssignment] Failed to read cache:", e);
    return null;
  }
}

function writeCache(email: string, assigned: string[], completed: string[]): void {
  try {
    const payload: AssignmentCache = {
      email,
      assigned_articles: [...assigned],
      completed_articles: [...completed],
      cachedAt: Date.now(),
    };
    localStorage.setItem(getCacheKey(email), JSON.stringify(payload));
  } catch (e) {
    console.warn("[useArticleAssignment] Failed to write cache:", e);
  }
}

function arraysEqualAsSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.filter(Boolean));
  const sb = new Set(b.filter(Boolean));
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

export function useArticleAssignment(email: string | null, refreshTrigger = 0) {
  const [assignedArticles, setAssignedArticles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAssignment = useCallback(async () => {
    const TS = () => `[${new Date().toISOString()}]`;
    const invId = String(Math.random()).slice(2, 8);
    console.log(`${TS()} [A-EVIDENCE-c] loadAssignment START [invocation=${invId}] for email=${email}. (This matches either: AnnotationWorkbench.handleSubmit direct await, OR useArticleAssignment useEffect trigger.) Current loading flag BEFORE setLoading(true): loading=`, loading, `email null?`, !email);
    console.log(`${TS()} [A-EVIDENCE-c] [inv=${invId}] FINAL setLoading(false) will appear as log line [inv=${invId}] FINALLY setLoading(false) exit. If you never see that line, this invocation hung.`);
    if (!email) {
      console.log(`${TS()} [A-EVIDENCE-c] [inv=${invId}] EXIT early: no email. setLoading(false).`);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(email));
      console.log("[useArticleAssignment] READ #1: annotator doc from:", annotatorRef.path);

      let annotatorDoc;
      try {
        annotatorDoc = await getDoc(annotatorRef);
      } catch (fetchErr: any) {
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

      if (annotatorDoc.exists()) {
        const data = annotatorDoc.data() as Annotator;
        currentAssignment = Array.isArray(data.assigned_articles) ? data.assigned_articles.filter(Boolean) : [];
        completed = Array.isArray(data.completed_articles) ? data.completed_articles.filter(Boolean) : [];
        console.log("[useArticleAssignment] Annotator server state:", {
          assigned_count: currentAssignment.length,
          completed_count: completed.length,
        });

        const cache = readCache(email);
        if (cache) {
          const assignedMatch = arraysEqualAsSets(cache.assigned_articles, currentAssignment);
          const completedMatch = arraysEqualAsSets(cache.completed_articles, completed);
          if (assignedMatch && completedMatch && currentAssignment.length > 0) {
            console.log(`[useArticleAssignment] CACHE HIT. assigned=${currentAssignment.length}, completed=${completed.length}. Skipping Strategy A/B query. READS SAVED: ~100 (Strategy A) + up to 500 (Strategy B fallback) = 600 reads avoided.`);
            setAssignedArticles(currentAssignment);
            setLoading(false);
            return;
          }
          console.log(`[useArticleAssignment] CACHE MISS (assignedMatch=${assignedMatch}, completedMatch=${completedMatch}). Running assignment query.`);
        } else {
          console.log("[useArticleAssignment] No cache found. Running assignment query.");
        }
      } else {
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

      if (currentAssignment.length < 20) {
        console.log("[useArticleAssignment] Need more articles. Calling assignArticlesForAnnotator...");
        console.log("[useArticleAssignment] READ #2 (Strategy A index): ~100 reads expected on composite index (status+sequence_number ASC). READ #3 (Strategy B fallback): up to 500 reads if Strategy A returns <20. WRITES: 20x setDoc merge (assigned_count increment + arrayUnion) via batch.");
        let moreArticles: string[] = [];
        try {
          moreArticles = await assignArticlesForAnnotator(email);
        } catch (assignErr) {
          console.error("[useArticleAssignment] assignArticlesForAnnotator THREW EXCEPTION:", assignErr);
          setError("Article assignment failed. Click 'Try Again' to retry.");
        }
        console.log("[useArticleAssignment] assignArticlesForAnnotator returned:", moreArticles.length, "articles:", moreArticles);

        if (moreArticles.length > 0) {
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
          writeCache(email, mergedAssignment, completed);
        } else {
          console.log("[useArticleAssignment] assignArticles returned empty list. Keeping current assignment:", currentAssignment);
          if (currentAssignment.length > 0) {
            setAssignedArticles(currentAssignment);
            writeCache(email, currentAssignment, completed);
          } else {
            setAssignedArticles([]);
            setError("No articles could be assigned. Make sure articles exist in Firestore with status=pending.");
          }
        }
      } else {
        console.log("[useArticleAssignment] Already have", currentAssignment.length, "articles (>= 20). Not fetching more.");
        setAssignedArticles(currentAssignment);
        writeCache(email, currentAssignment, completed);
      }

    } catch (err) {
      console.error("[useArticleAssignment] UNEXPECTED TOP-LEVEL ERROR:", err);
      setError("Failed to assign articles: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      console.log(`${TS()} [A-EVIDENCE-c] [inv=${invId}] FINALLY setLoading(false) exit. useArticleAssignment loadAssignment DONE OK.`);
      console.log("[useArticleAssignment] Finished loadAssignment");
    }
  }, [email]);

  useEffect(() => {
    const TS = () => `[${new Date().toISOString()}]`;
    console.log(`${TS()} [A-EVIDENCE-c] useArticleAssignment TRIGGERED → email=${email}, refreshTrigger=${refreshTrigger}. loadAssignment() called HERE (invocation #1 of any double-invocation when AnnotationWorkbench.handleSubmit also calls it directly).`);
    loadAssignment();
  }, [email, refreshTrigger, loadAssignment]);

  return { assignedArticles, loading, error, loadAssignment };
}
