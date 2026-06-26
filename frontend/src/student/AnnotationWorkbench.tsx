import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, updateDoc, setDoc, arrayUnion, increment, serverTimestamp, collection, getDocs, runTransaction, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { Article, Annotator, BiasLabel } from "../types";
import { useArticleAssignment } from "./useArticleAssignment";
import ProgressBar from "../components/ProgressBar";
import TimerRing from "../components/TimerRing";
import { Check, Loader2, AlertCircle } from "lucide-react";
import { calculateFleissKappa } from "../utils/calculateKappa";
import { calculateBiasScore } from "../utils/calculateBiasScore";
import { updatePlatformStats, syncAverageBiasScore } from "../utils/stats";

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

export default function AnnotationWorkbench() {
  const navigate = useNavigate();
  const session = JSON.parse(localStorage.getItem("nexus_user_session") || "{}");
  const userEmail = (session.email || "").toLowerCase().trim();
  const [assignmentRefresh, setAssignmentRefresh] = useState(0);
  const { assignedArticles, loading: assignmentLoading, loadAssignment } = useArticleAssignment(userEmail, assignmentRefresh);

  const [completedArticles, setCompletedArticles] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [currentArticle, setCurrentArticle] = useState<Article | null>(null);
  const [nextArticle, setNextArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [timerExpired, setTimerExpired] = useState(false);
  const [startTime, setStartTime] = useState<number>(0);
  const [articlesCache, setArticlesCache] = useState<Map<string, Article>>(new Map());

  // Form State
  const [label, setLabel] = useState<BiasLabel | null>(null);

  // Load article from cache or Firestore
  const loadArticleFromCacheOrDB = useCallback(async (articleId: string): Promise<Article | null> => {
    // Check cache first
    if (articlesCache.has(articleId)) {
      return articlesCache.get(articleId) as Article;
    }
    // If not in cache, fetch from DB and add to cache
    const articleDoc = await getDoc(doc(db, "articles", articleId));
    if (articleDoc.exists()) {
      const article = articleDoc.data() as Article;
      setArticlesCache(prev => {
        const newCache = new Map(prev);
        newCache.set(articleId, article);
        return newCache;
      });
      return article;
    }
    return null;
  }, [articlesCache]);

  // Preload next article
  const preloadNextArticle = useCallback(async (nextIndex: number): Promise<void> => {
    if (nextIndex < assignedArticles.length) {
      const nextArticleId = assignedArticles[nextIndex];
      if (!completedArticles.includes(nextArticleId)) {
        const article = await loadArticleFromCacheOrDB(nextArticleId);
        if (article) setNextArticle(article);
      }
    }
  }, [assignedArticles, completedArticles, loadArticleFromCacheOrDB]);

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
        const annotatorDoc = await getDoc(doc(db, "annotators", userEmail));
        if (annotatorDoc.exists()) {
          const data = annotatorDoc.data() as Annotator;
          const completed = data.completed_articles || [];
          setCompletedArticles(completed);
          setCompletedCount(completed.length);
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
      if (assignedArticles.length === 0) {
        if (!assignmentLoading) setLoading(false);
        return;
      }
      
      const firstPendingIndex = assignedArticles.findIndex(id => !completedArticles.includes(id));
      
      if (firstPendingIndex === -1) {
        if (!assignmentLoading) navigate("/done");
        return;
      }

      try {
        setCurrentIndex(firstPendingIndex);
        const articleId = assignedArticles[firstPendingIndex];
        const article = await loadArticleFromCacheOrDB(articleId);
        
        if (article) {
          setCurrentArticle(article);
          setStartTime(Date.now());
          setTimerExpired(false);
          setLabel(null);
          
          // Preload the next article right away!
          await preloadNextArticle(firstPendingIndex + 1);
        }
      } catch (err) {
        console.error("Error loading article:", err);
      } finally {
        setLoading(false);
      }
    }

    if (!assignmentLoading) {
      loadArticle();
    }
  }, [assignedArticles, assignmentLoading, completedArticles, navigate, loadArticleFromCacheOrDB, preloadNextArticle]);

  const handleSubmit = async () => {
    if (!currentArticle || !label || !timerExpired) return;

    if (!userEmail) {
      alert("Session expired. Please login again.");
      navigate("/");
      return;
    }

    const timeSpent = Math.round((Date.now() - startTime) / 1000);
    const articleId = currentArticle.article_id;
    const newCompletedCount = (completedCount || 0) + 1;

    // 1. INSTANT UI UPDATE - DO THIS FIRST BEFORE ANY DATABASE CALLS!
    setCompletedArticles(prev => [...prev, articleId]);
    setCompletedCount(newCompletedCount);
    
    // 2. CHECK IF WE NEED MORE ARTICLES FIRST!
    let nextPendingIndex = assignedArticles.findIndex(id => !completedArticles.includes(id) && id !== articleId);
    if (nextPendingIndex === -1 && newCompletedCount < 20) {
      // TRY TO REFILL ASSIGNMENT POOL!
      setAssignmentRefresh(prev => prev + 1);
      await loadAssignment();
      // Re-check next pending index after refresh
      nextPendingIndex = assignedArticles.findIndex(id => !completedArticles.includes(id) && id !== articleId);
    }

    // 3. SWITCH TO NEXT ARTICLE OR NAVIGATE TO DONE
    if (nextPendingIndex !== -1 && nextArticle) {
      setCurrentIndex(nextPendingIndex);
      setCurrentArticle(nextArticle);
      setStartTime(Date.now());
      setTimerExpired(false);
      setLabel(null);
      // Start preloading the article after next!
      preloadNextArticle(nextPendingIndex + 1);
    } else if (newCompletedCount >= 20) {
      navigate("/done");
      return;
    } else {
      // STILL NO ARTICLES AFTER REFRESH - MAYBE NO MORE IN DATABASE
      navigate("/done");
      return;
    }

    // 4. NOW SAVE TO DATABASE IN THE BACKGROUND - DON'T SHOW SUBMITTING SPINNER TO USER!
    try {
      await retryWithBackoff(async () => {
        // Prepare response data
        const responseData = {
          annotator_email: userEmail,
          label,
          timestamp: serverTimestamp(),
          time_spent_sec: timeSpent,
          is_gold_check: !!currentArticle.is_gold_standard
        };

        const responseRef = doc(db, "annotations", articleId, "responses", userEmail);
        const articleRef = doc(db, "articles", articleId);
        const annotatorRef = doc(db, "annotators", userEmail);

        let statusChangedTo: string | null = null;

        // ATOMIC TRANSACTION (Critical Data)
        await runTransaction(db, async (transaction) => {
          // Check for duplicate submission
          const responseSnap = await transaction.get(responseRef);
          if (responseSnap.exists()) {
            return; // Already submitted, no problem!
          }

          // Get current article state
          const articleSnap = await transaction.get(articleRef);
          if (!articleSnap.exists()) return;
          
          const articleData = articleSnap.data() as Article;
          const oldStatus = articleData.status;
          const newCount = (articleData.annotation_count || 0) + 1;
          
          let newStatus = oldStatus;
          if (newCount >= 10) {
            newStatus = "complete";
          } else if (newCount > 0) {
            newStatus = "partial";
          }

          // Get annotator state
          const annotatorSnap = await transaction.get(annotatorRef);
          if (!annotatorSnap.exists()) return;
          const annotatorData = annotatorSnap.data() as Annotator;

          // Perform updates
          transaction.update(articleRef, {
            annotation_count: increment(1),
            annotated_by: arrayUnion(userEmail),
            status: newStatus
          });

          transaction.set(responseRef, responseData);

          if (newStatus !== oldStatus) {
            statusChangedTo = newStatus;
          }

          const annotatorUpdates: any = {
            completed_articles: arrayUnion(articleId)
          };

          if (currentArticle.is_gold_standard && currentArticle.gold_expected_label) {
            const wasCorrect = label === currentArticle.gold_expected_label;
            const newTotal = (annotatorData.gold_total_count || 0) + 1;
            const newCorrect = (annotatorData.gold_correct_count || 0) + (wasCorrect ? 1 : 0);
            
            annotatorUpdates.gold_total_count = newTotal;
            annotatorUpdates.gold_correct_count = newCorrect;
            annotatorUpdates.gold_accuracy = Math.round((newCorrect / newTotal) * 100);
            annotatorUpdates.reliability_score = annotatorUpdates.gold_accuracy;
          } else if (currentArticle.is_gold_standard && !currentArticle.gold_expected_label) {
            console.warn("Skipping gold check update: Article is marked as gold standard but missing gold_expected_label", articleId);
          }

          const totalCompleted = (annotatorData.completed_articles?.length || 0) + 1;
          if (totalCompleted >= 20) {
            annotatorUpdates.completed = true;
          }

          transaction.update(annotatorRef, annotatorUpdates);
        });

        // NON-CRITICAL POST-TRANSACTION LOGIC (Stats & Scoring) - BACKGROUND
        (async () => {
          try {
            // Refresh annotator's completed articles from Firestore to avoid discrepancies
            const annotatorRefresh = await getDoc(annotatorRef);
            if (annotatorRefresh.exists()) {
              const newData = annotatorRefresh.data() as Annotator;
              setCompletedArticles(newData.completed_articles || []);
              setCompletedCount(newData.completed_articles?.length || 0);
            }

            if (statusChangedTo === "complete") {
              const responsesSnap = await getDocs(collection(db, "annotations", articleId, "responses"));
              const responses = responsesSnap.docs.map(d => d.data());
              const counts = {
                neutral: responses.filter(r => r.label === "neutral").length,
                slightly: responses.filter(r => r.label === "slightly_manipulative").length,
                highly: responses.filter(r => r.label === "highly_manipulative").length
              };
              const bias_score = calculateBiasScore(counts);
              const fleiss_kappa = calculateFleissKappa(counts);
              
              await updateDoc(articleRef, { bias_score, fleiss_kappa });
              
              const q = query(collection(db, "articles"), where("status", "==", "complete"));
              const snap = await getDocs(q);
              await syncAverageBiasScore(bias_score, snap.size);
            }

            if (statusChangedTo) {
              const statsUpdate: any = {};
              const oldStatus = currentArticle.status;
              if (oldStatus === "pending") statsUpdate.pendingArticles = -1;
              if (oldStatus === "partial") statsUpdate.inProgressArticles = -1;
              if (statusChangedTo === "partial") statsUpdate.inProgressArticles = 1;
              if (statusChangedTo === "complete") statsUpdate.completedArticles = 1;
              await updatePlatformStats(statsUpdate);
            }
          } catch (e) {
            console.warn("Background tasks failed:", e);
          }
        })();
      }, 3, 500); // 3 retries!
    } catch (err: any) {
      console.error("Submit failed after retries:", err);
      alert("Failed to save annotation. Please check your internet connection and refresh the page.");
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
          </div>
          <button 
            onClick={() => {
              localStorage.removeItem("nexus_user_session");
              window.location.href = "/";
            }}
            className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 transition-all"
          >
            Logout
          </button>
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
                onComplete={() => setTimerExpired(true)}
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
            
            {/* Article Metadata (Headline & Category) */}
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
          {/* Section: Manipulation Level */}
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

          {/* Section: Submit */}
          <div className="pt-4">
            <button
              onClick={handleSubmit}
              disabled={!label || !timerExpired || submitting}
              className={`w-full py-4 rounded-xl font-bold text-lg transition-all shadow-lg flex items-center justify-center gap-2 ${
                label && timerExpired && !submitting
                  ? "bg-primary text-white shadow-primary/25 hover:bg-primary/90"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed shadow-none"
              }`}
            >
              {submitting ? (
                <Loader2 className="animate-spin" size={24} />
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
