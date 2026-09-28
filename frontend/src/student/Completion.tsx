import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, increment } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../firebase";
import { Annotator } from "../types";
import { sanitizeEmailForDocId } from "../utils/sanitizeEmail";
import { clearAssignmentCache } from "./useArticleAssignment";
import { CheckCircle2, LogOut, Clock, Plus, Trophy, Sparkles } from "lucide-react";

export default function Completion() {
  const navigate = useNavigate();
  const [isFullyDone, setIsFullyDone] = useState(false);
  const [missionAccomplished, setMissionAccomplished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [extending, setExtending] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [currentTarget, setCurrentTarget] = useState(20);
  const userEmail = JSON.parse(localStorage.getItem("nexus_user_session") || "{}").email || "";

  useEffect(() => {
    async function checkStatus() {
      if (!userEmail) return;
      try {
        const docRef = doc(db, "annotators", sanitizeEmailForDocId(userEmail));
        let snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data() as Annotator;
          const completedArr = Array.isArray(data.completed_articles) ? data.completed_articles : [];
          const target = typeof data.target_annotations === "number" && data.target_annotations >= 20
            ? data.target_annotations
            : 20;
          setCurrentTarget(target);
          setCompletedCount(completedArr.length);

          const milestone20 = completedArr.length >= 20;
          setMissionAccomplished(milestone20 || !!data.completed);

          let confirmedDone = completedArr.length >= target;

          if (!confirmedDone && (completedArr.length >= Math.max(19, target - 1) || !!data.completed)) {
            await new Promise(r => setTimeout(r, 800));
            snap = await getDoc(docRef);
            if (snap.exists()) {
              const retryData = snap.data() as Annotator;
              const retryArr = Array.isArray(retryData.completed_articles) ? retryData.completed_articles : [];
              const retryTarget = typeof retryData.target_annotations === "number" && retryData.target_annotations >= 20
                ? retryData.target_annotations
                : 20;
              setCurrentTarget(retryTarget);
              setCompletedCount(retryArr.length);
              confirmedDone = retryArr.length >= retryTarget;
            }
          }
          setIsFullyDone(confirmedDone);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    checkStatus();
  }, [userEmail]);

  const handleExtendTarget = async () => {
    if (!userEmail || extending) return;
    setExtending(true);
    try {
      const annotatorRef = doc(db, "annotators", sanitizeEmailForDocId(userEmail));
      const snap = await getDoc(annotatorRef);
      let nextTarget = 40;
      if (snap.exists()) {
        const data = snap.data() as Annotator;
        const current = typeof data.target_annotations === "number" && data.target_annotations >= 20
          ? data.target_annotations
          : 20;
        nextTarget = current + 20;
      }
      await setDoc(annotatorRef, {
        target_annotations: nextTarget,
        assigned_articles_extended_count: increment(1),
      } as any, { merge: true });
      clearAssignmentCache(userEmail);
      navigate("/annotate");
    } catch (err) {
      console.error("[Completion] Failed to extend target:", err);
      alert("Could not assign the next 20 articles. Please check your connection and try again, or contact admin.");
      setExtending(false);
    }
  };

  const handleLogout = async () => {
    try {
      await auth.signOut();
      localStorage.removeItem("nexus_user_session");
      window.location.href = "/";
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  if (loading) return null;

  const showExtendButton = missionAccomplished;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-student p-6 relative overflow-hidden">
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />

      <div className="max-w-md w-full text-center space-y-8 bg-white p-12 rounded-[40px] shadow-2xl shadow-slate-200/50 border border-slate-100 relative animate-in fade-in zoom-in-95 duration-700">
        <div className={`absolute top-0 left-0 w-full h-1.5 ${missionAccomplished ? "bg-green-500" : "bg-blue-500"}`} />

        <div className="flex justify-center">
          <div className={`${missionAccomplished ? "bg-green-50" : isFullyDone ? "bg-green-50" : "bg-blue-50"} p-6 rounded-3xl relative`}>
            {missionAccomplished ? (
              <>
                <Trophy className="text-green-500" size={64} />
                <div className="absolute -top-2 -right-4 w-8 h-8 bg-yellow-100 rounded-full flex items-center justify-center shadow-sm animate-bounce">
                  <Sparkles size={18} className="text-yellow-500" />
                </div>
              </>
            ) : isFullyDone ? (
              <CheckCircle2 className="text-green-500" size={64} />
            ) : (
              <Clock className="text-blue-500" size={64} />
            )}
            <div className="absolute -top-2 -right-2 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-sm">
              <div className={`w-3 h-3 rounded-full ${missionAccomplished ? "bg-green-500" : isFullyDone ? "bg-green-500" : "bg-blue-500"}`} />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h1 className="text-4xl font-black text-slate-900 tracking-tighter">
            {missionAccomplished
              ? "Mission Accomplished!"
              : isFullyDone
              ? "Batch Completed"
              : "Keep Going!"}
          </h1>
          <p className="text-slate-500 leading-relaxed font-medium text-sm px-4">
            {missionAccomplished
              ? `You have completed ${completedCount} annotations — passing your initial goal of 20! Your contribution is vital in building the first labeled Urdu media bias dataset for Pakistan.`
              : isFullyDone
              ? `You have annotated all ${completedCount} currently available articles in your current batch (target: ${currentTarget}).`
              : "You have annotated all currently available articles. Please check back later to reach your target."}
          </p>

          <div className="flex items-center justify-center gap-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
            <span className="px-3 py-1 bg-slate-50 rounded-full border border-slate-100">
              Completed: <span className="text-slate-700">{completedCount}</span>
            </span>
            <span className="text-slate-300">/</span>
            <span className="px-3 py-1 bg-slate-50 rounded-full border border-slate-100">
              Target: <span className="text-slate-700">{currentTarget}</span>
            </span>
          </div>
        </div>

        <div className="pt-4 space-y-3">
          {showExtendButton && (
            <button
              onClick={handleExtendTarget}
              disabled={extending}
              className="w-full inline-flex items-center justify-center gap-3 bg-primary text-white px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              <Plus size={18} className={extending ? "animate-spin" : ""} />
              {extending ? "Assigning next 20 articles…" : "Annotate 20 more?"}
            </button>
          )}

          <button
            onClick={handleLogout}
            className="w-full inline-flex items-center justify-center gap-3 bg-slate-50 text-slate-500 px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-100 hover:text-slate-700 transition-all border border-slate-100"
          >
            <LogOut size={18} /> Exit Portal
          </button>
        </div>

        <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em]">
          NEXUS Research Project • 2026
        </p>
      </div>
    </div>
  );
}
