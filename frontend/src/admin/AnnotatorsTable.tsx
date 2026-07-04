import { useState, useEffect } from "react";
import { collection, onSnapshot, doc, updateDoc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { User, Mail, Hash, CheckCircle, Clock, ShieldAlert, Ban, Loader2, RefreshCw } from "lucide-react";

export default function AnnotatorsTable() {
  const [annotators, setAnnotators] = useState<Annotator[]>([]);
  const [loading, setLoading] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRegCode, setCreateRegCode] = useState("");

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "annotators"), (snapshot) => {
      setAnnotators(snapshot.docs.map(doc => doc.data() as Annotator));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleCreateAnnotator = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createEmail || !createName) return;
    setCreateLoading(true);

    try {
      const cleanEmail = createEmail.toLowerCase().trim();
      const annotatorRef = doc(db, "annotators", cleanEmail);
      
      const existingSnap = await getDoc(annotatorRef);
      if (existingSnap.exists()) {
        alert("Annotator already exists!");
        setCreateLoading(false);
        return;
      }

      const newAnnotator: Annotator = {
        email: cleanEmail,
        full_name: createName.trim(),
        registration_code: createRegCode.trim() || undefined,
        completed: false,
        completed_articles: [],
        assigned_articles: [],
        reliability_score: 0,
        gold_total_count: 0,
        gold_correct_count: 0,
        gold_accuracy: 0
      };

      await setDoc(annotatorRef, newAnnotator);
      
      setCreateEmail("");
      setCreateName("");
      setCreateRegCode("");
      alert("Annotator created successfully!");
    } catch (err: any) {
      console.error("Error creating annotator:", err);
      alert("Error creating annotator: " + err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  const toggleDeactivate = async (annotator: Annotator) => {
    try {
      const ref = doc(db, "annotators", annotator.email);
      await updateDoc(ref, { deactivated: !annotator.deactivated });
    } catch (err) {
      alert("Error updating annotator: " + err);
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
            doc(db, "annotations", articleId, "responses", email)
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
      const annotatorRef = doc(db, "annotators", annotator.email);
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-80">Annotator Reliability</h2>
        <p className="text-slate-50">Track student progress and performance on gold standard checks</p>
      </div>

      {/* Manual Annotator Creation Form */}
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
        <h3 className="text-lg font-bold text-slate-80 mb-6">Manually Add Annotator</h3>
        <form onSubmit={handleCreateAnnotator} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Email</label>
            <input
              type="email"
              required
              className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              placeholder="student@cuilahore.edu.pk"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Full Name</label>
            <input
              type="text"
              required
              className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              placeholder="Student Name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Reg. Code (Optional)</label>
            <div className="flex gap-3">
              <input
                type="text"
                className="flex-1 px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                placeholder="SP23-BSE-074"
                value={createRegCode}
                onChange={(e) => setCreateRegCode(e.target.value)}
              />
              <button
                type="submit"
                disabled={createLoading}
                className="bg-primary text-white px-6 py-3 rounded-xl font-bold hover:bg-primary-dark transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {createLoading ? <Loader2 className="animate-spin" size={20} /> : "Add"}
              </button>
            </div>
          </div>
        </form>
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
                            title="Recalculate Progress"
                          >
                            <RefreshCw size={18} />
                          </button>
                          <button 
                            onClick={() => toggleDeactivate(ann)}
                            className={`p-2 rounded-lg transition-colors ${
                              ann.deactivated 
                                ? "bg-slate-200 text-slate-600 hover:bg-slate-300" 
                                : "hover:bg-red-50 text-slate-400 hover:text-red-500"
                            }`}
                            title={ann.deactivated ? "Reactivate Account" : "Deactivate Account"}
                          >
                            <Ban size={18} />
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
