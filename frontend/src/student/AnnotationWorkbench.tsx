import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, updateDoc, setDoc, arrayUnion, increment, serverTimestamp, collection, getDocs, runTransaction, query, where } from "firebase/firestore";
import { auth, db } from "../firebase";
import { Article, Annotator, BiasLabel } from "../types";
import { useArticleAssignment } from "./useArticleAssignment";
import ProgressBar from "../components/ProgressBar";
import TimerRing from "../components/TimerRing";
import { Check, Loader2, AlertCircle } from "lucide-react";
import { calculateFleissKappa } from "../utils/calculateKappa";
import { calculateBiasScore } from "../utils/calculateBiasScore";
import { syncBiasScoreAndStatsAtomically } from "../utils/stats";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";
import { DEFAULT_REQUIRED_ANNOTATIONS } from "../utils/annotationConfig";

// Helper to retry async operations with exponential backoff (no generics to avoid errors)
const retryWithBackoff = async (
  fn: () => Promise<any>,
  retries = 3,
  delay = 500
): Promise<any> => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
};

// Wrap Firestore `getDoc` calls so that PERMISSION_DENIED (which happens
// for certain paths when Firestore rules can't evaluate to TRUE for a
// missing or in-between-state document) is treated as a "doc not found"
// shim instead of throwing. This prevents the optimistic UI from being
// rolled back when the transaction actually committed.
async function safeGetDoc(ref: any) {
  try {
    return await getDoc(ref);
  } catch (err: any) {
    const msg = (err && err.message) || "";
    const isPerm = (err && (err.code === "permission-denied" ||
      err.code === "firestore/permission-denied")) ||
      /permission|insufficient/i.test(msg);
    if (isPerm) {
      console.warn("[safeGetDoc] PERMISSION_DENIED on read of", ref.path, " — treating as not-exists");
      return { exists: () => false, data: () => ({} as any), id: ref.id } as any;
    }
    throw err;
  }
}

export default function AnnotationWorkbench() {
  const navigate = useNavigate();
  const session = JSON.parse(localStorage.getItem("nexus_user_session") || "{}");
  const userEmail = (session.email || "").toLowerCase().trim();
  console.log("[AnnotationWorkbench] User email from session:", userEmail);
  const [assignmentRefresh, setAssignmentRefresh] = useState(0);
  // Destructure all returns from useArticleAssignment!
  const { 
    assignedArticles, 
    loading: assignmentLoading, 
    error: assignmentError, 
    loadAssignment 
  } = useArticleAssignment(userEmail, assignmentRefresh);
  console.log("[AnnotationWorkbench] useArticleAssignment returned: assignedArticles=", assignedArticles, "assignmentLoading=", assignmentLoading);
  
  // Add state for assignedArticles to store locally!
  const [assignedArticlesState, setAssignedArticlesState] = useState<string[]>([]);

  const [completedArticles, setCompletedArticles] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [currentArticle, setCurrentArticle] = useState<Article | null>(null);
  const [nextArticle, setNextArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [verifyingFinalAnnotations, setVerifyingFinalAnnotations] = useState(false);
  const [timerExpired, setTimerExpired] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [articlesCache, setArticlesCache] = useState<Map<string, Article>>(new Map());

  // Form State
  const [label, setLabel] = useState<BiasLabel | null>(null);

  // Stable timer complete handler
  const handleTimerComplete = useCallback(() => {
    setTimerExpired(true);
  }, []);

  // Track last loaded article to prevent unnecessary reloads
  const lastLoadedArticleIdRef = useRef<string | null>(null);
  // Guard to prevent concurrent loadArticle() invocations (fixes hangs)
  const loadArticleRunningRef = useRef<boolean>(false);
  // Stable ref for articles cache so callbacks don't churn on cache updates
  const articlesCacheRef = useRef<Map<string, Article>>(new Map());
  const setArticlesCacheSync = (updater: (prev: Map<string, Article>) => Map<string, Article>) => {
    setArticlesCache(prev => {
      const next = updater(prev);
      articlesCacheRef.current = next;
      return next;
    });
  };

  // Sync our local assignedArticlesState with the one from useArticleAssignment
  // Always sync — even empty arrays — so switching users on same browser clears stale state.
  useEffect(() => {
    setAssignedArticlesState(assignedArticles);
  }, [assignedArticles]);

  // Load article from cache or Firestore
  // Uses articlesCacheRef for lookups (stable) instead of articlesCache state (churns deps).
  // Prevents infinite useEffect re-triggering when cache updates during loadArticle().
  const loadArticleFromCacheOrDB = useCallback(async (articleId: string): Promise<Article | null> => {
    if (articlesCacheRef.current.has(articleId)) {
      return articlesCacheRef.current.get(articleId) as Article;
    }
    const articleDoc = await getDoc(doc(db, "articles", articleId));
    if (articleDoc.exists()) {
      const article = articleDoc.data() as Article;
      setArticlesCacheSync(prev => {
        const newCache = new Map(prev);
        newCache.set(articleId, article);
        return newCache;
      });
      return article;
    }
    return null;
  }, []);

  // Preload next article
  const preloadNextArticle = useCallback(async (nextIndex: number): Promise<void> => {
    if (nextIndex < assignedArticlesState.length) {
      const nextArticleId = assignedArticlesState[nextIndex];
      if (!completedArticles.includes(nextArticleId)) {
        const article = await loadArticleFromCacheOrDB(nextArticleId);
        if (article) setNextArticle(article);
      }
    }
  }, [assignedArticlesState, completedArticles, loadArticleFromCacheOrDB]);

  // Update lastActive timestamp on every action
  useEffect(() => {
    const sessionStr = localStorage.getItem("nexus_user_session");
    if (sessionStr) {
      const session = JSON.parse(sessionStr);
      session.lastActive = new Date().toISOString();
      localStorage.setItem("nexus_user_session", JSON.stringify(session));
    }
  }, [currentIndex, completedCount]);

  // Initial load of annotator state
  useEffect(() => {
    async function initAnnotator() {
      if (!userEmail) return;
      try {
        const annotatorDoc = await getDoc(doc(db, "annotators", sanitizeEmailForDocId(userEmail)));
        if (annotatorDoc.exists()) {
          const data = annotatorDoc.data() as Annotator;
          const completed = data.completed_articles || [];
          setCompletedArticles(completed);
          setCompletedCount(Math.min(completed.length, 20));
        }
      } catch (err) {
        console.error("Error loading annotator:", err);
      }
    }
    initAnnotator();
  }, [userEmail]);

  // Load current article based on assigned pool and local completed state
  useEffect(() => {
    async function loadArticle() {
      if (loadArticleRunningRef.current) {
        return;
      }
      loadArticleRunningRef.current = true;
      try {
      if (assignedArticlesState.length === 0) {
        if (!assignmentLoading) setLoading(false);
        return;
      }
      
      const firstPendingIndex = assignedArticlesState.findIndex(id => !completedArticles.includes(id));
      
      if (firstPendingIndex === -1) {
        if (!assignmentLoading && completedArticles.length >= 20) {
          navigate("/done");
        } else if (!assignmentLoading) {
          setLoading(false);
        }
        return;
      }

      try {
        setCurrentIndex(firstPendingIndex);
        const articleId = assignedArticlesState[firstPendingIndex];
        
        if (articleId !== lastLoadedArticleIdRef.current) {
          lastLoadedArticleIdRef.current = articleId;
          
          const article = await loadArticleFromCacheOrDB(articleId);
          
          if (article) {
            setCurrentArticle(article);
            setStartTime(Date.now());
            setTimerExpired(false);
            setLabel(null);
            
            await preloadNextArticle(firstPendingIndex + 1);
          } else {
            console.warn(`[AnnotationWorkbench] loadArticleFromCacheOrDB(${articleId}) returned null/undefined — article may not exist in Firestore.`);
          }
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error("Error loading article:", err);
      } finally {
        setLoading(false);
      }
      } finally {
        loadArticleRunningRef.current = false;
      }
    }

    if (!assignmentLoading) {
      loadArticle();
    }
  }, [assignedArticlesState, assignmentLoading, completedArticles, navigate, loadArticleFromCacheOrDB, preloadNextArticle]);

  const handleSubmit = async () => {
    if (!currentArticle || !label || !timerExpired) return;

    if (!userEmail) {
      alert("Session expired. Please login again.");
      navigate("/");
      return;
    }

    const timeSpent = Math.round((Date.now() - startTime) / 1000);
    const articleId = currentArticle.article_id;

    // --- 1. INSTANT OPTIMISTIC UI UPDATE ---
    const newCompletedArticles = [...completedArticles, articleId];
    setCompletedArticles(newCompletedArticles);
    const newCompletedCount = Math.min(completedCount + 1, 20);
    setCompletedCount(newCompletedCount);

    // --- 2. CAPTURE ALL VARS WE NEED TO SAVE FIRST ---
    const savedLabel = label;
    const savedCurrentArticle = currentArticle;
    setSubmitting(true);

    let txnCommitted = false;

    try {
      // --- 3. FIRST START THE SAVE TO DATABASE AND AWAIT IT ---
      await retryWithBackoff(async () => {
        const responseData = {
          annotator_email: userEmail,
          label: savedLabel,
          timestamp: serverTimestamp(),
          time_spent_sec: timeSpent,
          is_gold_check: !!savedCurrentArticle.is_gold_standard
        };

        const responseRef = doc(db, "annotations", articleId, "responses", sanitizeEmailForDocId(userEmail));
        const articleRef = doc(db, "articles", articleId);
        const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(userEmail));

        // Utility: wrap transaction.get() so PERMISSION_DENIED on a doc that
        // doesn't exist yet (e.g. a brand-new response doc) is treated as a
        // "missing doc" snapshot instead of aborting the whole transaction.
        // This is needed because Firestore rules cannot differentiate between
        // a "legitimate read of a missing doc by the owner" vs a probe — they
        // always throw for missing docs when no read rule passes.
        const txGetSafe = async (t: any, ref: any) => {
          try { return await t.get(ref); }
          catch (err: any) {
            const msg = (err && err.message) || "";
            const isPerm = (err && (err.code === "permission-denied" ||
              err.code === "firestore/permission-denied")) ||
              /permission|insufficient/i.test(msg);
            if (isPerm) {
              // Safe default: a "not exists" doc shim so callers behave as if
              // the doc simply hasn't been written yet.
              return { exists: () => false, data: () => ({} as any), id: ref.id } as any;
            }
            throw err;
          }
        };

        let finalBiasScoreForStats = 0;
        let prevStatusForStats: "pending" | "partial" | undefined;
        let nextStatusForStats: "partial" | "complete" | null = null;

        // ── DIAG: Lift computed values OUT of runTransaction closure so the
        // post-commit read-back block (which runs AFTER runTransaction resolves)
        // can compare the read-back Firestore value to what we computed INSIDE
        // the atomic transaction. Previously `completionCounts` was declared
        // inside the callback and was undefined outside → diagnostic printed
        // MATCH_*: undefined every single run.
        let lastTxCompletionCounts: { neutral: number; slightly: number; highly: number } | null = null;
        let lastTxBiasScore: number | null = null;
        let lastTxKappa: number | null = null;
        let lastTxFinalLabel: BiasLabel | null = null;
        let scoreBranchEntered = false;

        await runTransaction(db, async (transaction) => {
          const responseSnap = await txGetSafe(transaction, responseRef);
          if (responseSnap.exists()) {
            console.debug(`[DIAG-Issue1] article=${articleId} idempotency-guard: response doc exists → bail.`);
            return;
          }

          const articleSnap = await txGetSafe(transaction, articleRef);
          if (!articleSnap.exists()) {
            console.debug(`[DIAG-Issue1] article=${articleId} article doc MISSING → bail.`);
            return;
          }
          const articleData = articleSnap.data() as Article;

          // Authoritative distinct annotator list from article.annotated_by (sorted, deduped, live-normalised)
          const emailNorm = userEmail.toLowerCase().trim();
          const priorAnnotated = Array.isArray(articleData.annotated_by) ? articleData.annotated_by : [];
          const priorAnnotatorsNormalised = priorAnnotated
            .map((e) => typeof e === "string" ? e.toLowerCase().trim() : "")
            .filter((e) => !!e);
          const priorDistinctAnnotatorSet = new Set(priorAnnotatorsNormalised);
          const priorDistinctCount = priorDistinctAnnotatorSet.size;

          console.debug(`[DIAG-Issue1] article=${articleId} submitter=${emailNorm}`, {
            priorDistinctCount,
            priorAnnotated_by: priorAnnotated,
            article_annotation_count: articleData.annotation_count,
            article_status_before: articleData.status,
            article_bias_before: articleData.bias_score,
            article_kappa_before: articleData.fleiss_kappa,
            article_finalLabel_before: articleData.final_label,
          });

          // Guard: student has already submitted?
          if (priorDistinctAnnotatorSet.has(emailNorm)) {
            console.debug(`[DIAG-Issue1] article=${articleId} already-in-annotated_by guard → bail.`);
            return;
          }

          // Guard: article already has 5 distinct submissions?
          const REQUIRED = DEFAULT_REQUIRED_ANNOTATIONS;
          if (priorDistinctCount >= REQUIRED) {
            console.debug(`[DIAG-Issue1] article=${articleId} priorDistinctCount=${priorDistinctCount}>=${REQUIRED} → bail (full).`);
            return;
          }

          const annotatorSnap = await txGetSafe(transaction, annotatorRef);
          if (!annotatorSnap.exists()) {
            console.debug(`[DIAG-Issue1] article=${articleId} annotator doc MISSING → bail.`);
            return;
          }
          const annotatorData = annotatorSnap.data() as Annotator;

          // Single authoritative next state
          const newAnnotatedBy = Array.from(new Set([...priorAnnotated.map((e: any) => typeof e === "string" ? e.toLowerCase().trim() : "").filter(Boolean), emailNorm]));
          const newAnnotationCount = newAnnotatedBy.length;
          let newStatus: Article["status"] = articleData.status;
          if (newAnnotationCount >= REQUIRED) newStatus = "complete";
          else if (newAnnotationCount > 0) newStatus = "partial";
          else newStatus = "pending";

          console.debug(`[DIAG-Issue1] article=${articleId} derived-new-state:`, {
            newAnnotatedBy,
            newAnnotationCount,
            newStatus,
            WILL_ENTER_SCORE_BRANCH: newStatus === "complete" && newAnnotationCount >= REQUIRED,
          });

          const articleUpdates: any = {
            annotation_count: newAnnotationCount,
            annotated_by: newAnnotatedBy,
            status: newStatus,
          };

          // When reaching exactly 5 DISTINCT annotators → compute everything atomically
          // in the SAME transaction so bias/kappa/final_label can never be missing on completion
          if (newStatus === "complete" && newAnnotationCount >= REQUIRED) {
            scoreBranchEntered = true;
            console.groupCollapsed(`[DIAG-Issue1] 5TH-ANNOTATION COMPLETION BRANCH — article=${articleId}`);
            const priorResponses: any[] = [];

            // ── IMPORTANT: NO collection/query reads inside a Firestore transaction ──
            // Firestore `transaction.get()` only accepts DocumentReference.
            // Passing a Query/CollectionReference to transaction.get() is
            // UNSUPPORTED by the SDK (hard runtime error) AND TypeScript correctly
            // rejects it (the error you just saw: Query missing id/path/parent/toJSON).
            // The prior code called txGetSafe(transaction, collection(...)) which
            // SWALLOWED this thrown error in its catch-all → returned a fake
            // "not exists" doc shim with NO .docs property → priorResponses.length
            // stayed 0 → bias/kappa computed with ONLY the 5th submitter's label.
            //
            // Strategy 1 (LIST) is removed. We only use Strategy 2 (individual
            // per-doc GETs via DocumentReference → transaction.get(priorRef)),
            // which IS valid inside a transaction.
            const priorCountExpected = priorAnnotated.length; // should be REQUIRED-1=4
            console.debug(`[DIAG-Issue1] priorAnnotated (expected prior=${priorCountExpected})=`, priorAnnotated);

            for (const priorEmailRaw of priorAnnotated) {
              const priorEmail = typeof priorEmailRaw === "string" ? priorEmailRaw : "";
              if (!priorEmail) continue;
              const priorDocId = sanitizeEmailForDocId(priorEmail);
              const priorRef = doc(db, "annotations", articleId, "responses", priorDocId);
              try {
                console.debug(`[DIAG-Issue1] tx.get(DocumentReference) → responses/${priorDocId} (${priorEmail})`);
                // NOTE: Do NOT wrap in txGetSafe here. txGetSafe has a permission→notExists
                // shim that swallows real errors. We use raw transaction.get so that
                // ANY thrown error has its full Firebase `code`/`message` logged.
                let priorSnap;
                try {
                  priorSnap = await transaction.get(priorRef);
                } catch (innerErr: any) {
                  const innerCode = innerErr?.code ?? "NO_CODE";
                  const innerMsg = (innerErr?.message ?? String(innerErr)).slice(0, 200);
                  console.warn(
                    `[DIAG-Issue1] tx.get FAILED for priorEmail=${priorEmail} responses/${priorDocId}. ` +
                    `code=${innerCode}. msg=${innerMsg}. THIS PRIOR ANNOTATOR'S LABEL WILL BE EXCLUDED from bias/kappa/final_label. ` +
                    `HINT: If code=permission-denied, check rules allow GET on /annotations/{articleId}/responses/{docId}. ` +
                    `If code=not-found, response doc was never written for that annotator (article.annotated_by may be stale).`
                  );
                  continue;
                }
                if (priorSnap && typeof priorSnap.exists === "function" && priorSnap.exists()) {
                  const d = priorSnap.data();
                  if (d && typeof d.label === "string") {
                    priorResponses.push(d);
                    console.debug(`[DIAG-Issue1] ADDED label=${d.label} from priorEmail=${priorEmail}. priorResponses.length=${priorResponses.length}.`);
                  } else {
                    console.warn(`[DIAG-Issue1] Doc for priorEmail=${priorEmail} had no valid label field. d.label=${String(d?.label)}`);
                  }
                } else {
                  const exFn = priorSnap && typeof priorSnap.exists === "function" ? priorSnap.exists() : "priorSnap_malformed";
                  console.warn(`[DIAG-Issue1] priorEmail=${priorEmail} doc exists?=${String(exFn)}. Response doc MISSING for known annotator. Article.annotated_by may contain stale entries.`);
                }
              } catch (outerErr: any) {
                const outerCode = outerErr?.code ?? "NO_CODE";
                const outerMsg = (outerErr?.message ?? String(outerErr)).slice(0, 200);
                console.warn(`[DIAG-Issue1] OUTER unexpected error for priorEmail=${priorEmail}. code=${outerCode}. msg=${outerMsg}`);
              }
            }

            const labelsFromPrior = priorResponses.map((r: any) => r.label);
            console.debug(`[DIAG-Issue1] FINAL priorResponses SUMMARY:`, {
              expectedPriorCount: REQUIRED - 1,
              actualPriorCount: priorResponses.length,
              labelsFromPrior,
              submitterSavedLabel: savedLabel,
            });

            const allCounts = { neutral: 0, slightly: 0, highly: 0 };
            for (const r of priorResponses) {
              if (r.label === "neutral") allCounts.neutral++;
              else if (r.label === "slightly_manipulative") allCounts.slightly++;
              else if (r.label === "highly_manipulative") allCounts.highly++;
              else console.warn(`[DIAG-Issue1] Unexpected label value in prior response: label=${String(r.label)} annotator_email=${String(r.annotator_email)}`);
            }
            if (savedLabel === "neutral") allCounts.neutral++;
            else if (savedLabel === "slightly_manipulative") allCounts.slightly++;
            else if (savedLabel === "highly_manipulative") allCounts.highly++;
            else console.warn(`[DIAG-Issue1] Unexpected savedLabel value! savedLabel=${String(savedLabel)}`);

            console.debug(`[DIAG-Issue1] allCounts (after adding submitter label)=`, allCounts);

            const biasScore = calculateBiasScore(allCounts);
            const kappa = calculateFleissKappa(allCounts);

            // Map count-keys ("slightly", "highly") back to their canonical BiasLabel enum
            // values ("slightly_manipulative", "highly_manipulative") so the stored
            // final_label matches the rest of the codebase (ExportCSV, types, etc.).
            const countKeyToBiasLabel = (k: string): BiasLabel | null => {
              if (k === "neutral") return "neutral";
              if (k === "slightly") return "slightly_manipulative";
              if (k === "highly") return "highly_manipulative";
              return null;
            };
            const entries = (Object.entries(allCounts) as Array<[string, number]>);
            entries.sort((a, b) => b[1] - a[1]);
            const [topKey, topCount] = entries[0];
            const [_secondKey, secondCount] = entries[1];
            const topLabel = countKeyToBiasLabel(topKey);
            const finalLabelVal =
              (topCount > 0 && topCount !== secondCount && topLabel !== null) ? topLabel : null;

            console.debug(`[DIAG-Issue1] COMPUTED SCORES:`, {
              biasScore,
              kappa,
              topKey, topLabel, topCount,
              secondKey: _secondKey, secondCount,
              finalLabelVal,
              tie_or_noMajority: topCount === secondCount || topCount === 0,
            });

            articleUpdates.bias_score = biasScore;
            articleUpdates.fleiss_kappa = kappa;
            articleUpdates.final_label = finalLabelVal;

            // Write to OUTER closure (see variable declaration above runTransaction)
            lastTxCompletionCounts = allCounts;
            lastTxBiasScore = biasScore;
            lastTxKappa = kappa;
            lastTxFinalLabel = finalLabelVal;
            finalBiasScoreForStats = biasScore;

            const has_bias = Object.prototype.hasOwnProperty.call(articleUpdates, "bias_score");
            const has_kappa = Object.prototype.hasOwnProperty.call(articleUpdates, "fleiss_kappa");
            const has_final = Object.prototype.hasOwnProperty.call(articleUpdates, "final_label");
            console.debug(`[DIAG-Issue1] articleUpdates object that will be transaction.set(merge=true):`, {
              has_bias_score: has_bias,
              bias_score_value: articleUpdates.bias_score,
              has_fleiss_kappa: has_kappa,
              fleiss_kappa_value: articleUpdates.fleiss_kappa,
              has_final_label: has_final,
              final_label_value: articleUpdates.final_label,
              ALL_THREE_SCORE_KEYS_PRESENT: has_bias && has_kappa && has_final,
              annotation_count: articleUpdates.annotation_count,
              annotated_by_length: articleUpdates.annotated_by.length,
              status: articleUpdates.status,
            });
            console.groupEnd();
          }

          transaction.set(articleRef, articleUpdates, { merge: true });
          transaction.set(responseRef, responseData);

          if (articleData.status !== newStatus) {
            prevStatusForStats = articleData.status === "pending" || articleData.status === "partial"
              ? articleData.status
              : undefined;
            nextStatusForStats = newStatus === "partial" || newStatus === "complete" ? newStatus : null;
          }

          const annotatorUpdates: any = {
            completed_articles: arrayUnion(articleId)
          };
          if (savedCurrentArticle.is_gold_standard && savedCurrentArticle.gold_expected_label) {
            const wasCorrect = savedLabel === savedCurrentArticle.gold_expected_label;
            const newTotal = (annotatorData.gold_total_count || 0) + 1;
            const newCorrect = (annotatorData.gold_correct_count || 0) + (wasCorrect ? 1 : 0);
            annotatorUpdates.gold_total_count = newTotal;
            annotatorUpdates.gold_correct_count = newCorrect;
            annotatorUpdates.gold_accuracy = Math.round((newCorrect / newTotal) * 100);
            annotatorUpdates.reliability_score = annotatorUpdates.gold_accuracy;
          }
          const totalCompleted = (annotatorData.completed_articles?.length || 0) + 1;
          if (totalCompleted >= 20) annotatorUpdates.completed = true;
          transaction.set(annotatorRef, annotatorUpdates, { merge: true });
        });

        if (nextStatusForStats) {
          try {
            await syncBiasScoreAndStatsAtomically(finalBiasScoreForStats, prevStatusForStats, nextStatusForStats);
          } catch (e) {
            console.warn("Stats sync post-transaction failed:", e);
          }
        }

        // ---- DIAGNOSTIC: POST-COMMIT READ-BACK -----------------------------------
        // Immediately re-read the article doc to PROVE the values were persisted.
        // Uses the out-of-closure `lastTxCompletionCounts` / `lastTxBiasScore` etc.
        // to 100% guarantee we're comparing the same values the transaction wrote.
        try {
          const _delay = (ms: number) => new Promise(r => setTimeout(r, ms));
          await _delay(10);
          const verifyArticleRef = doc(db, "articles", articleId);
          const verifySnap = await safeGetDoc(verifyArticleRef);
          if (verifySnap.exists()) {
            const vd = verifySnap.data() as Article;
            if (vd.status === "complete") {
              console.groupCollapsed(`[DIAG-Issue1-POSTCOMMIT] article=${articleId} READBACK AFTER COMMIT (10 ms)`);
              const expectedBias = lastTxBiasScore;
              const expectedKappa = lastTxKappa;
              const biasMatch = (expectedBias == null || vd.bias_score == null)
                ? Object.is(expectedBias, vd.bias_score)
                : Math.abs(Number(vd.bias_score) - Number(expectedBias)) < 0.001;
              const kappaMatch = (expectedKappa == null || vd.fleiss_kappa == null)
                ? Object.is(expectedKappa, vd.fleiss_kappa)
                : Math.abs(Number(vd.fleiss_kappa) - Number(expectedKappa)) < 0.001;
              const labelMatch = Object.is(vd.final_label, lastTxFinalLabel);
              const allScoresPresent = (vd.bias_score != null) && (vd.fleiss_kappa != null);
              console.debug({
                scoreBranchEntered,
                status: vd.status,
                annotation_count: vd.annotation_count,
                annotated_by_length: vd.annotated_by?.length ?? 0,
                // READBACK (actual Firestore state)
                bias_score_readback: vd.bias_score,
                fleiss_kappa_readback: vd.fleiss_kappa,
                final_label_readback: vd.final_label,
                // EXPECTED (closure values computed inside tx and written via merge)
                bias_score_transaction: expectedBias,
                fleiss_kappa_transaction: expectedKappa,
                final_label_transaction: lastTxFinalLabel,
                MATCH_bias: biasMatch,
                MATCH_kappa: kappaMatch,
                MATCH_finalLabel: labelMatch,
                SCORES_PRESENT_in_READBACK: allScoresPresent,
                FAILURE_CLASSIFICATION:
                  !scoreBranchEntered ? "A — SCORE BRANCH NEVER ENTERED (newAnnotationCount<5 or newStatus!=complete — see WILL_ENTER_SCORE_BRANCH line)" :
                  !allScoresPresent ? "B — SCORE BRANCH ENTERED BUT SCORES NOT WRITTEN (see ALL_THREE_SCORE_KEYS_PRESENT line, should be true)" :
                  (!biasMatch || !kappaMatch || !labelMatch) ? "B-VALUES — SCORE BRANCH ENTERED AND WROTE BUT VALUES ARE WRONG (see MATCH_* lines — any false)" :
                  "OK — scores physically written AND match in-transaction values",
              });
              console.groupEnd();
            } else {
              console.debug(`[DIAG-Issue1-POSTCOMMIT] article=${articleId} status=${vd.status} (not complete) — skip score comparison.`);
            }
          }
        } catch (postReadErr) {
          console.warn(`[DIAG-Issue1-POSTCOMMIT] read-back failed`, postReadErr);
        }
        // ---- END DIAGNOSTIC POST-COMMIT READBACK --------------------------------
      }, 3, 500);

      // --- 4. Transaction was atomic — if we reached here, the save is DONE.
      txnCommitted = true;

      // --- 5. Lightweight verify: try to read the response doc (non-fatal if
      // rules block it — we trust the atomic transaction). If the annotator
      // read fails on PERMISSION_DENIED, we continue using the optimistic
      // local state instead of throwing and confusing the user.
      let completedCountFromServer: number | null = null;
      let latestAssignedArticles: string[] = [...assignedArticlesState];
      let latestCompletedArticles: string[] = [...newCompletedArticles];
      let latestAnnotator: Annotator | null = null;

      try {
        const verifyRef = doc(db, "annotations", articleId, "responses", sanitizeEmailForDocId(userEmail));
        const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(userEmail));
        const [verifyDoc, initialAnnotatorCheck] = await Promise.all([
          safeGetDoc(verifyRef),
          safeGetDoc(annotatorRef),
        ]);
        // Treat a missing verification doc only as a soft-warning (console).
        if (!verifyDoc.exists()) {
          console.warn("[AnnotationWorkbench] Could not independently verify response doc (rules?), but transaction succeeded.");
        }
        if (initialAnnotatorCheck.exists()) {
          const data = initialAnnotatorCheck.data() as Annotator;
          latestAnnotator = data;
          completedCountFromServer = data.completed_articles?.length ?? newCompletedArticles.length;
          latestAssignedArticles = Array.isArray(data.assigned_articles) ? data.assigned_articles.filter(Boolean) : latestAssignedArticles;
          latestCompletedArticles = Array.isArray(data.completed_articles) ? data.completed_articles.filter(Boolean) : latestCompletedArticles;
          // Refresh local state with server truth immediately.
          setAssignedArticlesState(latestAssignedArticles);
          setCompletedArticles(latestCompletedArticles);
          setCompletedCount(Math.min(latestCompletedArticles.length, 20));
        } else {
          completedCountFromServer = newCompletedArticles.length;
        }
      } catch (readErr: any) {
        console.warn("[AnnotationWorkbench] Soft post-save reads failed — falling back to optimistic state:", readErr);
        completedCountFromServer = newCompletedArticles.length;
      }
      
      // Find next pending index using the LATEST data
      let nextPendingIndex = latestAssignedArticles.findIndex(id => !latestCompletedArticles.includes(id) && id !== articleId);

      // --- 6. If completed count reached 20, go straight to the done screen.
      if (latestCompletedArticles.length >= 20) {
        setSubmitting(false);
        navigate("/done");
        return;
      }

      // If we still don't have a next article, and haven't reached 20 completed, try to load more!
      if (nextPendingIndex === -1 && latestCompletedArticles.length < 20) {
        setAssignmentRefresh(prev => prev + 1);
        await loadAssignment();
        
        // Get the VERY latest data after loadAssignment completes
        const afterLoadAnnotatorDoc = await safeGetDoc(doc(db, "annotators", sanitizeEmailForDocId(userEmail)));
        if (afterLoadAnnotatorDoc.exists()) {
          const afterLoadData = afterLoadAnnotatorDoc.data() as Annotator;
          latestAssignedArticles = afterLoadData.assigned_articles || [];
          latestCompletedArticles = afterLoadData.completed_articles || [];
          
          // Check again for a next pending index
          nextPendingIndex = latestAssignedArticles.findIndex(id => !latestCompletedArticles.includes(id) && id !== articleId);
        }
      }

      // ── SINGLE SOURCE OF TRUTH: ONE consolidated state update. ──
      // NEVER call setCurrentIndex / setCurrentArticle from handleSubmit.
      // The useEffect (lines ~171–229) owns ALL article transitions:
      //   • It reads assignedArticlesState + completedArticles (which we set here)
      //   • Uses loadArticleRunningRef guard against concurrent execution
      //   • Uses lastLoadedArticleIdRef to skip re-loads of the same article
      //   • Resets startTime / timerExpired / label correctly
      //   • Preloads the FOLLOWING article after advancing
      // This eliminates the race where BOTH handleSubmit + useEffect wrote
      // setCurrentArticle(article2) concurrently (causing TimerRing remount loop
      // + label reset mid-user-interaction = UI freeze on 2nd article).
      setAssignedArticlesState(latestAssignedArticles);
      setCompletedArticles(latestCompletedArticles);
      setCompletedCount(Math.min(latestCompletedArticles.length, 20));

      if (nextPendingIndex === -1) {
        setSubmitting(false);
        if (latestCompletedArticles.length >= 20) {
          navigate("/done");
        } else {
          console.warn("[AnnotationWorkbench] No next article, but we haven't completed 20 yet—waiting!");
          alert("You've annotated all available articles! Please check back later for more to reach your 20-article target.");
        }
      } else {
        // Submitting ends NOW. The useEffect will take it from here.
        // Invalidate lastLoadedArticleIdRef so the useEffect RE-LOADS the next
        // article (finds it via findIndex on latestAssignedArticles / latestCompletedArticles
        // which we just wrote above) instead of short-circuiting on a stale id.
        // Setting to null forces the load guard (line: articleId !== lastLoadedRef)
        // to pass the very next time useEffect runs.
        lastLoadedArticleIdRef.current = null;
        setSubmitting(false);
      }

    } catch (err: any) {
      console.error("Annotation save flow error (txnCommitted=", txnCommitted, "):", err);
      setSubmitting(false);
      setVerifyingFinalAnnotations(false);

      if (txnCommitted) {
        // The Firestore write actually succeeded — the error came from a
        // soft post-read / navigation. The annotation is persisted. Do NOT
        // roll back the optimistic UI so the user isn't confused into
        // re-annotating the same article (and double-incrementing server data).
        console.warn("[AnnotationWorkbench] Transaction already committed before error. Keeping optimistic UI state.");
        // If a soft error happened but we can't reliably advance, reload.
        alert("Your annotation was saved. The next article is loading slowly — please refresh if nothing changes.");
      } else {
        // Actual write failure — undo the optimistic UI.
        alert("Annotation failed to save properly. Please refresh and try again!");
        setCompletedArticles(prev => prev.filter(id => id !== articleId));
        setCompletedCount(prev => prev - 1);
      }
    }
  };

  if (loading || assignmentLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-student">
        <Loader2 className="animate-spin text-primary" size={40} />
      </div>
    );
  }

  if (!currentArticle) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-student p-6">
        <div className="max-w-md w-full text-center space-y-6 bg-white p-12 rounded-3xl shadow-sm border border-slate-100">
          <div className="bg-amber-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="text-amber-500" size={32} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-slate-800">No articles available</h2>
            <p className="text-slate-500">
              There are currently no articles assigned to you or available for annotation. 
              Please contact the research administrator.
            </p>
            {assignmentError && (
              <p className="text-red-500 text-xs mt-2">Error: {assignmentError}</p>
            )}
          </div>
          <div className="space-y-3">
            <button
              onClick={async () => {
                setAssignmentRefresh(prev => prev + 1);
                setLoading(true);
                await loadAssignment();
              }}
              className="w-full py-3 bg-primary text-white rounded-xl font-bold hover:bg-primary/90 transition-all"
            >
              Try Loading Articles Again
            </button>
            <button 
              onClick={async () => {
                try { await auth.signOut(); } catch (e) { /* ignore */ }
                localStorage.removeItem("nexus_user_session");
                window.location.href = "/";
              }}
              className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 transition-all"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-student flex flex-col animate-in fade-in duration-700">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 p-6 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="w-72">
            <ProgressBar current={completedCount + 1} total={20} />
          </div>
          <div className="text-primary font-black text-3xl tracking-tighter">NEXUS</div>
          <div className="w-72 flex justify-end">
            <div className="bg-slate-50 px-4 py-2 rounded-2xl border border-slate-100 flex items-center gap-3">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reading Timer</span>
              <TimerRing
                key={currentArticle.article_id}
                duration={10}
                onComplete={handleTimerComplete}
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 md:p-12 grid grid-cols-1 md:grid-cols-10 gap-12">
        {/* Left Panel: Article */}
        <div className="md:col-span-6 space-y-6">
          <div className="bg-white rounded-[32px] p-10 shadow-xl shadow-slate-200/50 border border-slate-100 min-h-[500px] flex flex-col relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-1 h-full bg-primary/10 group-hover:bg-primary transition-colors" />
            
            <div className="mb-8 pb-8 border-b border-slate-100 space-y-4">
              <div className="flex items-center justify-between">
                <span className="px-4 py-1.5 bg-primary/10 text-primary rounded-xl text-[10px] font-black uppercase tracking-widest border border-primary/20">
                  {currentArticle.category || "Uncategorized"}
                </span>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  Topic Category
                </span>
              </div>
              <h1 
                className="font-urdu text-4xl font-bold leading-relaxed text-right text-slate-900"
                dir="rtl"
              >
                {currentArticle.headline}
              </h1>
            </div>

            <div 
              className="font-urdu text-2xl leading-[2.4] text-right text-slate-700 flex-1" 
              dir="rtl"
            >
              {currentArticle.display_text}
            </div>
          </div>
          <div className="flex items-center gap-3 text-slate-400 text-xs font-bold uppercase tracking-wider bg-white/50 p-4 rounded-2xl border border-slate-100">
            <AlertCircle size={18} className="text-primary" />
            <span>Judge only the writing style and tone. Source and author are hidden.</span>
          </div>
        </div>

        {/* Right Panel: Form */}
        <div className="md:col-span-4 space-y-10">
          <section className="space-y-5">
            <h3 className="font-black text-slate-400 uppercase tracking-[0.15em] text-[10px]">
              What is the tone of this excerpt?
            </h3>
            <div className="flex flex-col gap-3">
              {(["neutral", "slightly_manipulative", "highly_manipulative"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setLabel(opt)}
                  className={`flex items-center justify-between p-5 rounded-2xl border-2 transition-all font-bold ${
                    label === opt 
                      ? "border-primary bg-primary/5 text-primary shadow-sm" 
                      : "border-slate-100 bg-white text-slate-500 hover:border-slate-200"
                  }`}
                >
                  <span className="capitalize">{opt.replace("_", " ")}</span>
                  <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                    label === opt ? "bg-primary border-primary text-white" : "border-slate-200"
                  }`}>
                    {label === opt && <Check size={14} strokeWidth={4} />}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <div className="pt-4">
            <button
              onClick={handleSubmit}
              disabled={!label || !timerExpired || submitting || verifyingFinalAnnotations}
              className={`w-full py-4 rounded-xl font-bold text-lg transition-all shadow-lg flex items-center justify-center gap-2 ${
                label && timerExpired && !submitting && !verifyingFinalAnnotations
                  ? "bg-primary text-white shadow-primary/25 hover:bg-primary/90"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed shadow-none"
              }`}
            >
              {submitting && !verifyingFinalAnnotations ? (
                <Loader2 className="animate-spin" size={24} />
              ) : verifyingFinalAnnotations ? (
                <>
                  <Loader2 className="animate-spin" size={24} />
                  <span>Saving & Verifying Final Annotations...</span>
                </>
              ) : !timerExpired ? (
                <span>Wait for timer...</span>
              ) : !label ? (
                <span>Select a tone to continue</span>
              ) : (
                <>Submit & Next <Check size={20} /></>
              )}
            </button>
            {!timerExpired && (
              <p className="text-center text-xs text-slate-400 mt-3">
                Please read the article thoroughly before submitting.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
