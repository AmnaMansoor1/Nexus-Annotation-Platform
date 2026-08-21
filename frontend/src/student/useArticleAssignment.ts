import { useState, useEffect, useCallback, useRef } from "react";
import { doc, getDoc, setDoc, collection, getDocs, limit, orderBy, query, where, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { assignArticlesForAnnotator } from "../utils/assignArticles";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";
import { fetchAnnotatorContext, healArticles } from "../utils/reconcileArticle";

const CACHE_KEY_PREFIX = "nexus_assignment_cache_v2_";
const LEGACY_CACHE_KEY_PREFIX = "nexus_assignment_cache_v1_";

function clearLegacyCache(email: string): void {
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY_PREFIX + sanitizeEmailForDocId(email));
  } catch {
    /* ignore */
  }
}

export function clearAssignmentCache(email: string): void {
  try {
    localStorage.removeItem(getCacheKey(email));
    clearLegacyCache(email);
  } catch {
    /* ignore */
  }
}

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

/**
 * Lightweight self-heal for annotators who already have ≥20 assigned articles.
 *
 * Strategy A/B query is normally skipped in the ≥20 branch, which means
 * article-level ghost assigned_to/assigned_count never get repaired. This
 * function runs a cheap self-heal on the first 150 candidate articles so
 * counts stay healthy even without running the full assignment select.
 *
 * Also guarantees the annotator doc's assigned_articles[] is the SINGLE
 * source of truth — if it holds article IDs that are missing from article
 * assigned_to, those are re-added to the articles (prevents drift when
 * article writes fail mid-flight). Returns the deduplicated, authoritative
 * assigned list derived from annotatorContext truth plus annotator-doc
 * entries (merged, deduped).
 */
async function lightSelfHeal(
  email: string,
  assignedArticles: string[],
  completedArticles: string[]
): Promise<{ assigned: string[]; repaired: boolean }> {
  const emailNorm = email.toLowerCase().trim();
  let annotatorCtx;
  try {
    annotatorCtx = await fetchAnnotatorContext();
  } catch {
    return {
      assigned: [...new Set(assignedArticles.filter(Boolean))],
      repaired: false,
    };
  }

  let repaired = false;
  try {
    const strategyAQ = query(
      collection(db, "articles"),
      where("status", "in", ["pending", "partial"]),
      orderBy("sequence_number", "asc"),
      limit(150)
    );
    const snap = await getDocs(strategyAQ);
    const raws = snap.docs.map((d) => ({
      ...(d.data() as any),
      article_id: d.id,
    }));
    const preRepair = raws.filter(r => {
      const ac = typeof r.assigned_count === "number" ? r.assigned_count : 0;
      const at = Array.isArray(r.assigned_to) ? r.assigned_to : [];
      return ac !== at.length;
    }).length;
    await healArticles(raws, annotatorCtx, undefined);
    const postRepair = raws.length - preRepair;
    if (postRepair > 0) repaired = true;
  } catch (e) {
    try {
      const fbQ = query(collection(db, "articles"), orderBy("sequence_number", "asc"), limit(300));
      const fbSnap = await getDocs(fbQ);
      const raws = fbSnap.docs.map((d) => ({ ...(d.data() as any), article_id: d.id }));
      await healArticles(raws, annotatorCtx, undefined);
      repaired = true;
    } catch (_) { /* ignore */ }
  }

  const truths = annotatorCtx.articlesByAssignee;
  const dedupedAssigned = [...new Set(assignedArticles.filter(Boolean))];

  const missingSyncIds: string[] = [];
  for (const id of dedupedAssigned) {
    if (!id) continue;
    const truthEmails = truths.get(id);
    const inAnnotatorTruth = truthEmails && truthEmails.has(emailNorm);
    if (!inAnnotatorTruth) {
      missingSyncIds.push(id);
    }
  }
  void completedArticles;

  if (missingSyncIds.length > 0) {
    try {
      const docs = await Promise.all(
        missingSyncIds.map((id) => getDoc(doc(db, "articles", id)))
      );
      const syncBatch = writeBatch(db);
      let batched = 0;
      for (let i = 0; i < docs.length; i++) {
        const snap = docs[i];
        const id = missingSyncIds[i];
        if (!snap.exists()) continue;
        const data = snap.data() as any;
        const currentAssignedTo = Array.isArray(data.assigned_to) ? data.assigned_to : [];
        const currentCount = typeof data.assigned_count === "number" ? data.assigned_count : 0;
        const hasEmail = currentAssignedTo.some(
          (e: any) => typeof e === "string" && e.toLowerCase().trim() === emailNorm
        );
        if (!hasEmail) {
          const next = Array.from(new Set([...currentAssignedTo, email])).filter(Boolean);
          syncBatch.set(doc(db, "articles", id), {
            assigned_to: next,
            assigned_count: Math.max(currentCount + 1, next.length),
          }, { merge: true });
          batched++;
        }
      }
      if (batched > 0) {
        await syncBatch.commit();
        repaired = true;
        console.log(`[lightSelfHeal] Re-synced ${batched} article reverse-index slots for annotator ${emailNorm}.`);
      }
    } catch (syncErr) {
      console.warn("[lightSelfHeal] Reverse-index sync pass failed:", syncErr);
    }
  }

  return { assigned: dedupedAssigned, repaired };
}

export function useArticleAssignment(email: string | null, refreshTrigger = 0) {
  const [assignedArticles, setAssignedArticles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadAssignmentRunningRef = useRef(false);

  const loadAssignment = useCallback(async () => {
    if (!email) {
      setLoading(false);
      return;
    }

    if (loadAssignmentRunningRef.current) {
      console.log("[useArticleAssignment] Re-entrancy guard: loadAssignment already in progress. Skipping this call.");
      return;
    }
    loadAssignmentRunningRef.current = true;

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
        clearLegacyCache(email);
        const data = annotatorDoc.data() as Annotator;
        currentAssignment = Array.isArray(data.assigned_articles) ? data.assigned_articles.filter(Boolean) : [];
        completed = Array.isArray(data.completed_articles) ? data.completed_articles.filter(Boolean) : [];
        console.log("[useArticleAssignment] Annotator server state:", {
          assigned_count: currentAssignment.length,
          completed_count: completed.length,
        });

        const cache = readCache(email);
        if (cache && currentAssignment.length >= 20) {
          const assignedMatch = arraysEqualAsSets(cache.assigned_articles, currentAssignment);
          const completedMatch = arraysEqualAsSets(cache.completed_articles, completed);
          if (assignedMatch && completedMatch && currentAssignment.length > 0) {
            console.log(`[useArticleAssignment] CACHE HIT (≥20 branch). assigned=${currentAssignment.length}. Running lightSelfHeal to keep counts healthy while returning authoritative list.`);
            try {
              void lightSelfHeal(email, currentAssignment, completed);
            } catch (_) { /* fire-and-forget */ }
            setAssignedArticles(currentAssignment);
            setLoading(false);
            return;
          }
          console.log(`[useArticleAssignment] CACHE MISS ≥20 branch (assignedMatch=${assignedMatch}, completedMatch=${completedMatch}). Will NOT skip — running lightSelfHeal + returning server list.`);
        } else if (cache && currentAssignment.length < 20) {
          const assignedMatch = arraysEqualAsSets(cache.assigned_articles, currentAssignment);
          const completedMatch = arraysEqualAsSets(cache.completed_articles, completed);
          if (assignedMatch && completedMatch && currentAssignment.length > 0) {
            console.log(`[useArticleAssignment] CACHE HIT (<20 branch) but assigned < 20 — WILL IGNORE CACHE and run assignment query to fetch remaining articles. READS SAVED on subsequent login after 20 reached.`);
          }
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
          const mergedAssignment = moreArticles.slice(0, 20);
          console.log("[useArticleAssignment] Authoritative assignment (", mergedAssignment.length, "):", mergedAssignment);

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
        console.log("[useArticleAssignment] Already have", currentAssignment.length, "articles (>= 20). Light self-heal kicked off; returning server-authoritative list.");
        try {
          void lightSelfHeal(email, currentAssignment, completed);
        } catch (_) { /* fire-and-forget */ }
        setAssignedArticles(currentAssignment);
        writeCache(email, currentAssignment, completed);
      }

    } catch (err) {
      console.error("[useArticleAssignment] UNEXPECTED TOP-LEVEL ERROR:", err);
      setError("Failed to assign articles: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      loadAssignmentRunningRef.current = false;
      setLoading(false);
      console.log("[useArticleAssignment] Finished loadAssignment");
    }
  }, [email]);

  useEffect(() => {
    loadAssignment();
  }, [email, refreshTrigger, loadAssignment]);

  return { assignedArticles, loading, error, loadAssignment };
}
