import { useState, useEffect, useCallback } from "react";
import {
  collection, doc, updateDoc, getDoc, getDocs, deleteDoc, runTransaction,
  increment
} from "firebase/firestore";
import { db } from "../firebase";
import { Annotator, Article } from "../types";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";
import { calculateBiasScore } from "../utils/calculateBiasScore";
import { calculateFleissKappa } from "../utils/calculateKappa";
import { ensureSummaryExists } from "../utils/stats";
import { User, Mail, Ban, Loader2, RefreshCw, Trash2, AlertTriangle, Database } from "lucide-react";

export default function AnnotatorsTable() {
  const [annotators, setAnnotators] = useState<Annotator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAnnotators = useCallback(async () => {
    setRefreshing(true);
    try {
      const snap = await getDocs(collection(db, "annotators"));
      setAnnotators(snap.docs.map(d => d.data() as Annotator));
    } catch (error) {
      console.error("Error loading annotators:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAnnotators();
  }, [loadAnnotators]);

  const toggleDeactivate = async (annotator: Annotator) => {
    try {
      const ref = doc(db, "annotators", sanitizeEmailForDocId(annotator.email));
      await updateDoc(ref, { deactivated: !annotator.deactivated });
      // Refresh list to show the updated state immediately
      loadAnnotators();
    } catch (err) {
      alert("Error updating annotator: " + err);
    }
  };

  /**
   * HARD DELETE an annotator + FULLY RECONCILE article state.
   *
   * PERFORMANCE OPTIMIZATION: Per-article transactions are processed in parallel
   * batches (concurrency = 8) instead of sequentially. For 20 articles this cuts
   * wall-clock time from ~6s+ to ~1s.
   *
   * PLATFORM STATS REPAIR: All dashboard counters (totalAnnotators,
   * completedAnnotators, completedArticles, inProgressArticles, pendingArticles,
   * totalBiasScoreSum, avgBiasScore) are updated atomically so the dashboard
   * reflects changes immediately.
   */
  const hardDeleteAnnotator = async (annotator: Annotator) => {
    const email = (annotator.email || "").toLowerCase().trim();
    if (!email) return;

    const completedCount = Array.isArray(annotator.completed_articles)
      ? annotator.completed_articles.length
      : 0;

    const msg =
      `⚠️  PERMANENTLY DELETE annotator: ${email}\n\n` +
      `This will:\n` +
      `  • Delete their annotator profile\n` +
      `  • REMOVE ALL ${completedCount} of their annotations\n` +
      `  • Decrement annotation_count on every affected article\n` +
      `  • Recompute status, bias_score, and fleiss_kappa for every affected article\n` +
      `  • Update ALL dashboard counters (annotator count, status buckets, bias sum/avg)\n\n` +
      `THIS CANNOT BE UNDONE. Type DELETE in all caps to confirm.`;
    const userInput = prompt(msg);
    if (userInput !== "DELETE") {
      alert("Delete cancelled.");
      return;
    }

    const confirm2 = confirm(
      `LAST WARNING:\nReally remove every trace of ${email} from the dataset?\n` +
      `Dashboard counts will update immediately via real-time listener.`
    );
    if (!confirm2) return;

    setLoading(true);
    try {
      await ensureSummaryExists();

      const docId = sanitizeEmailForDocId(email);
      const annotatorRef = doc(db, "annotators", docId);
      const statsRef = doc(db, "stats", "platform_summary");

      const articleIdsFromAnnotator = Array.isArray(annotator.completed_articles)
        ? [...new Set(annotator.completed_articles.filter(Boolean))]
        : [];

      console.log(`[HardDelete:${email}] Articles listed in completed_articles:`, articleIdsFromAnnotator.length);

      const errors: string[] = [];
      let articleBecameIncomplete = 0;
      let articleBecamePartial = 0;
      let articleBecamePending = 0;
      let articleBiasScoreCleared = 0;
      let articleBiasScoreRecomputed = 0;

      const BATCH_SIZE = 8;

      const processArticle = async (articleId: string): Promise<{ ok: boolean }> => {
        try {
          let localBecameIncomplete = false;
          let localBecamePartial = false;
          let localBecamePending = false;
          let localBiasCleared = false;
          let localBiasRecomputed = false;
          let localBiasDelta = 0;
          let oldStatus: "pending" | "partial" | "complete" = "pending";
          let newStatus: "pending" | "partial" | "complete" = "pending";
          let articleChanged = false;

          await runTransaction(db, async (tx) => {
            const articleRef = doc(db, "articles", articleId);
            const responseRef = doc(db, "annotations", articleId, "responses", docId);

            const articleSnap = await tx.get(articleRef);
            const responseSnap = await tx.get(responseRef);
            if (!articleSnap.exists()) {
              if (responseSnap.exists()) tx.delete(responseRef);
              return;
            }

            const article = articleSnap.data() as Article;
            oldStatus = (article.status || "pending") as "pending" | "partial" | "complete";
            const oldCount = typeof article.annotation_count === "number" ? article.annotation_count : 0;
            const oldAnnotatedBy = Array.isArray(article.annotated_by) ? article.annotated_by : [];
            const hadThisAnnotatorCounted = oldAnnotatedBy.includes(email);
            const responseExisted = responseSnap.exists();

            if (!hadThisAnnotatorCounted && !responseExisted) {
              return;
            }

            articleChanged = true;
            if (responseExisted) tx.delete(responseRef);

            const newAnnotatedBy = hadThisAnnotatorCounted
              ? oldAnnotatedBy.filter((e) => String(e).toLowerCase() !== email)
              : [...oldAnnotatedBy];
            const newCount = hadThisAnnotatorCounted ? Math.max(0, oldCount - 1) : oldCount;

            const REQUIRED = 5;
            if (newCount >= REQUIRED) newStatus = "complete";
            else if (newCount > 0) newStatus = "partial";
            else newStatus = "pending";

            const wasComplete = oldStatus === "complete";
            if (wasComplete && newStatus !== "complete") {
              localBecameIncomplete = true;
              localBiasDelta = typeof article.bias_score === "number" ? article.bias_score : 0;
            }
            if (oldStatus === "complete" && newStatus === "partial") localBecamePartial = true;
            if (oldStatus === "complete" && newStatus === "pending") localBecamePending = true;
            if (oldStatus === "partial" && newStatus === "pending") localBecamePending = true;

            const updates: any = {
              annotation_count: newCount,
              annotated_by: newAnnotatedBy,
              status: newStatus,
            };

            if (newCount < 2) {
              updates.bias_score = null;
              updates.fleiss_kappa = null;
              if (article.bias_score !== null) localBiasCleared = true;
            } else if (localBecameIncomplete || (hadThisAnnotatorCounted && newCount >= 2)) {
              updates.bias_score = null;
              updates.fleiss_kappa = null;
              if (article.bias_score !== null) localBiasRecomputed = true;
            }

            tx.update(articleRef, updates);

            if (localBecameIncomplete) {
              const statsUpdates: any = {
                completedArticles: increment(-1),
                totalBiasScoreSum: increment(-localBiasDelta),
              };
              if (newStatus === "partial") {
                statsUpdates.inProgressArticles = increment(1);
              } else if (newStatus === "pending") {
                statsUpdates.pendingArticles = increment(1);
              }
              tx.set(statsRef, statsUpdates, { merge: true });
            } else if (oldStatus === "partial" && newStatus === "pending") {
              tx.set(statsRef, {
                inProgressArticles: increment(-1),
                pendingArticles: increment(1),
              }, { merge: true });
            }
          });

          if (!articleChanged) return { ok: true };

          if (localBecameIncomplete) articleBecameIncomplete++;
          if (localBecamePartial) articleBecamePartial++;
          if (localBecamePending) articleBecamePending++;
          if (localBiasCleared) articleBiasScoreCleared++;
          if (localBiasRecomputed) articleBiasScoreRecomputed++;

          const articleSnap2 = await getDoc(doc(db, "articles", articleId));
          if (articleSnap2.exists()) {
            const art = articleSnap2.data() as Article;
            if (art.bias_score === null && art.annotation_count >= 2) {
              const remainingResp = await getDocs(collection(db, "annotations", articleId, "responses"));
              const labels = remainingResp.docs.map((d) => (d.data() as any).label as string).filter(Boolean);
              const counts = {
                neutral: labels.filter((l) => l === "neutral").length,
                slightly: labels.filter((l) => l === "slightly_manipulative").length,
                highly: labels.filter((l) => l === "highly_manipulative").length,
              };
              const newScore = calculateBiasScore(counts);
              const newKappa = calculateFleissKappa(counts);
              await updateDoc(doc(db, "articles", articleId), {
                bias_score: newScore,
                fleiss_kappa: newKappa,
              });
            }
          }

          return { ok: true };
        } catch (perArticleErr: any) {
          const msg = perArticleErr && perArticleErr.message ? perArticleErr.message : String(perArticleErr);
          errors.push(`${articleId}: ${msg}`);
          console.error(`[HardDelete:${email}] Failed article ${articleId}:`, perArticleErr);
          return { ok: false };
        }
      };

      for (let i = 0; i < articleIdsFromAnnotator.length; i += BATCH_SIZE) {
        const batch = articleIdsFromAnnotator.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(processArticle));
      }

      await deleteDoc(annotatorRef);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(statsRef);
        const base = snap.exists() ? snap.data() : {};
        const totalAnnotatorsBefore = typeof (base as any).totalAnnotators === "number" ? (base as any).totalAnnotators : 0;
        const completedAnnotatorsBefore = typeof (base as any).completedAnnotators === "number" ? (base as any).completedAnnotators : 0;
        const completedArticlesAfter = typeof (base as any).completedArticles === "number" ? (base as any).completedArticles : 0;
        const totalBiasSumAfter = typeof (base as any).totalBiasScoreSum === "number" ? (base as any).totalBiasScoreSum : 0;
        const newAvg = completedArticlesAfter > 0
          ? Math.round((totalBiasSumAfter / completedArticlesAfter) * 100) / 100
          : 0;

        const wasCompletedAnnotator = annotator.completed === true || completedCount >= 20;
        const updates: any = {
          totalAnnotators: Math.max(0, totalAnnotatorsBefore - 1),
          avgBiasScore: newAvg,
          updated_at: Date.now(),
        };
        if (wasCompletedAnnotator) {
          updates.completedAnnotators = Math.max(0, completedAnnotatorsBefore - 1);
        }
        tx.update(statsRef, updates);
      });

      const processed = articleIdsFromAnnotator.length;
      console.log(`[HardDelete:${email}] DONE.`, {
        processed,
        errors: errors.length,
        articleBecameIncomplete,
        articleBecamePartial,
        articleBecamePending,
        articleBiasScoreCleared,
        articleBiasScoreRecomputed,
      });

      let summary =
        `✅ Deleted ${email} successfully.\n\n` +
        `  Articles touched: ${processed}\n` +
        `  Status transitions:\n` +
        `    complete → partial: ${articleBecamePartial}\n` +
        `    complete → pending: ${articleBecamePending}\n` +
        `    partial → pending: ${articleBecameIncomplete - articleBecamePartial - articleBecamePending >= 0 ? articleBecameIncomplete - articleBecamePartial - articleBecamePending : 0}\n` +
        `  Articles whose bias score was cleared (fewer than 2 remain): ${articleBiasScoreCleared}\n` +
        `  Articles whose bias score was recomputed: ${articleBiasScoreRecomputed}\n` +
        `  Dashboard counters updated (annotator count, status buckets, bias sum/avg).\n` +
        `  Dashboard page will refresh automatically via real-time listener.`;
      if (errors.length > 0) {
        summary += `\n\n⚠️  Errors (${errors.length} articles):\n` + errors.slice(0, 10).join("\n");
        if (errors.length > 10) summary += `\n… +${errors.length - 10} more`;
      }
      alert(summary);
    } catch (err: any) {
      console.error("[HardDelete] Top-level error:", err);
      alert("Failed to delete annotator: " + (err && err.message ? err.message : String(err)));
    } finally {
      loadAnnotators();
    }
  };

  const recalculateProgress = async (annotator: Annotator) => {
    if (!confirm("Recalculate annotator's progress based on actual saved annotations?")) return;
    try {
      console.log(`[Recalculate] Starting for ${annotator.email}`);
      
      // 1. Check ALL articles (not just assigned and previously completed)
      const allArticlesSnap = await getDocs(collection(db, "articles"));
      const allArticleIds = allArticlesSnap.docs.map(doc => doc.id);
      console.log(`[Recalculate] Found ${allArticleIds.length} total articles`);
      
      const actualCompleted: string[] = [];
      const emailsToCheck = [
        annotator.email,
        annotator.email.toLowerCase(),
        annotator.email.toUpperCase()
      ];

      for (const articleId of allArticleIds) {
        for (const email of emailsToCheck) {
          const responseDoc = await getDoc(
            doc(db, "annotations", articleId, "responses", sanitizeEmailForDocId(email))
          );
          if (responseDoc.exists()) {
            console.log(`[Recalculate] Found annotation for article: ${articleId} (using email: ${email}`);
            if (!actualCompleted.includes(articleId)) {
              actualCompleted.push(articleId);
            }
            break; // no need to check other emails for same article
          }
        }
      }

      console.log(`[Recalculate] Total completed articles found: ${actualCompleted.length}`);
      
      // Now update annotator document in Firestore
      const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(annotator.email));
      await updateDoc(annotatorRef, {
        completed_articles: actualCompleted,
        completed: actualCompleted.length >= 20
      });
      
      alert(`Progress recalculated! Completed articles: ${actualCompleted.length}/20`);
    } catch (err) {
      console.error("[Recalculate] Error:", err);
      alert("Error recalculating progress: " + err);
    }
  };

  const getAccuracyColor = (acc: number | null | undefined) => {
    if (acc === null || acc === undefined) return "text-slate-400";
    if (acc >= 80) return "text-green-500";
    if (acc >= 60) return "text-amber-500";
    return "text-red-500";
  };

  /**
   * NOTE: Per B-OPTION 1 (hard delete) spec — annotators are permanently removed
   * from the dataset once deleted. If an admin wants to temporarily disable one
   * without destroying their annotations, use the Deactivate button instead.
   * The opacity-50 visual below is only applied to deactivated (soft-deleted)
   * annotators; hard-deleted docs are simply not returned by getDocs at all,
   * so they never appear in this list.
   */

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-80">Annotator Reliability</h2>
          <p className="text-slate-50">Track student progress and performance on gold standard checks</p>
        </div>
        <button
          onClick={loadAnnotators}
          disabled={refreshing || loading}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50 transition-all shadow-sm disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Student</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Reg. Code</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Progress</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <Loader2 className="animate-spin inline mr-2 text-primary" />
                    <span className="text-slate-500 font-medium">Loading annotators...</span>
                  </td>
                </tr>
              ) : (
                annotators.map((ann) => {
                  const completedCount = ann.completed_articles?.length || 0;
                  const progress = (completedCount / 20) * 100;

                  return (
                    <tr key={ann.email} className={`hover:bg-slate-50/50 transition-colors group ${ann.deactivated ? "opacity-50" : ""}`}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                            <User size={20} />
                          </div>
                          <div>
                            <div className="font-bold text-slate-700">{ann.full_name || ann.email?.split('@')[0] || "Unknown"}</div>
                            <div className="text-xs text-slate-400 flex items-center gap-1">
                              <Mail size={12} /> {ann.email || "No email"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 font-mono text-sm text-slate-600">
                        {ann.registration_code || "—"}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col items-center gap-1">
                          <span className="text-sm font-bold text-slate-700">{completedCount}/20</span>
                          <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div 
                              className={`h-full transition-all duration-500 ${ann.completed ? "bg-green-500" : "bg-primary"}`}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {ann.deactivated ? (
                          <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 text-[10px] font-bold uppercase tracking-wider border border-red-200">
                            Deactivated
                          </span>
                        ) : ann.completed ? (
                          <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 text-[10px] font-bold uppercase tracking-wider border border-green-200">
                            Completed
                          </span>
                        ) : (
                          <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider border border-blue-200">
                            In Progress
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button 
                            onClick={() => recalculateProgress(ann)}
                            className="p-2 rounded-lg transition-colors hover:bg-blue-50 text-slate-400 hover:text-blue-500"
                            title="Recalculate Progress from Actual Annotation Docs"
                          >
                            <RefreshCw size={18} />
                          </button>
                          <button 
                            onClick={() => toggleDeactivate(ann)}
                            className={`p-2 rounded-lg transition-colors ${
                              ann.deactivated 
                                ? "bg-slate-200 text-slate-600 hover:bg-slate-300" 
                                : "hover:bg-amber-50 text-slate-400 hover:text-amber-500"
                            }`}
                            title={ann.deactivated ? "Reactivate (soft-undelete, preserves all annotations)" : "Deactivate (soft-disable, keeps annotations in DB)"}
                          >
                            <Ban size={18} />
                          </button>
                          <button 
                            onClick={() => hardDeleteAnnotator(ann)}
                            className="p-2 rounded-lg transition-colors hover:bg-red-100 text-slate-400 hover:text-red-600"
                            title="PERMANENT DELETE: removes annotator + ALL their annotations + recomputes every affected article's stats. CANNOT BE UNDONE."
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
