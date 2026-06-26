import { useState, useEffect } from "react";
import { collection, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator } from "../types";
import { User, Mail, Hash, CheckCircle, Clock, ShieldAlert, Ban, Loader2 } from "lucide-react";

export default function AnnotatorsTable() {
  const [annotators, setAnnotators] = useState<Annotator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "annotators"), (snapshot) => {
      setAnnotators(snapshot.docs.map(doc => doc.data() as Annotator));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const toggleDeactivate = async (annotator: Annotator) => {
    try {
      const ref = doc(db, "annotators", annotator.email);
      await updateDoc(ref, { deactivated: !annotator.deactivated });
    } catch (err) {
      alert("Error updating annotator: " + err);
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
        <h2 className="text-2xl font-bold text-slate-800">Annotator Reliability</h2>
        <p className="text-slate-500">Track student progress and performance on gold standard checks</p>
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
