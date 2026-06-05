import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { Annotator } from "../types";
import { CheckCircle2, LogOut, Clock } from "lucide-react";

export default function Completion() {
  const [isFullyDone, setIsFullyDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const userEmail = JSON.parse(localStorage.getItem("nexus_user_session") || "{}").email || "";

  useEffect(() => {
    async function checkStatus() {
      if (!userEmail) return;
      try {
        const docRef = doc(db, "annotators", userEmail);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          setIsFullyDone(snap.data().completed);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    checkStatus();
  }, [userEmail]);

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-student p-6 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />

      <div className="max-w-md w-full text-center space-y-8 bg-white p-12 rounded-[40px] shadow-2xl shadow-slate-200/50 border border-slate-100 relative animate-in fade-in zoom-in-95 duration-700">
        <div className="absolute top-0 left-0 w-full h-1.5 bg-green-500" />
        
        <div className="flex justify-center">
          <div className={`${isFullyDone ? "bg-green-50" : "bg-blue-50"} p-6 rounded-3xl relative`}>
            {isFullyDone ? (
              <CheckCircle2 className="text-green-500" size={64} />
            ) : (
              <Clock className="text-blue-500" size={64} />
            )}
            <div className="absolute -top-2 -right-2 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-sm">
              <div className={`w-3 h-3 rounded-full ${isFullyDone ? "bg-green-500" : "bg-blue-500"}`} />
            </div>
          </div>
        </div>
        
        <div className="space-y-4">
          <h1 className="text-4xl font-black text-slate-900 tracking-tighter">
            {isFullyDone ? "Mission Accomplished!" : "Batch Completed"}
          </h1>
          <p className="text-slate-500 leading-relaxed font-medium text-sm px-4">
            {isFullyDone 
              ? "You have completed all 20 annotations. Your contribution is vital in building the first labeled Urdu media bias dataset for Pakistan."
              : "You have annotated all currently available articles. Please check back later to reach your target of 20."}
          </p>
        </div>

        <div className="pt-4">
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
