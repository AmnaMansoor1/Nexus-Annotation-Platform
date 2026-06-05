import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { AdminConfig } from "../types";
import { Save, Loader2, CheckCircle2 } from "lucide-react";

export default function Settings() {
  const [config, setConfig] = useState<AdminConfig>({
    total_target: 100,
    gold_article_ids: [],
    annotators_per_article: 10
  });
  const [goldInput, setGoldInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      const docSnap = await getDoc(doc(db, "admin_config", "settings"));
      if (docSnap.exists()) {
        const data = docSnap.data() as AdminConfig;
        setConfig(data);
        setGoldInput(data.gold_article_ids.join(", "));
      }
      setLoading(false);
    }
    loadSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccess(false);

    const goldIds = goldInput.split(",").map(id => id.trim()).filter(id => id !== "");
    const newConfig = { ...config, gold_article_ids: goldIds };

    try {
      await setDoc(doc(db, "admin_config", "settings"), newConfig);
      setConfig(newConfig);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      alert("Failed to save settings: " + err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8 text-center"><Loader2 className="animate-spin inline mr-2" /> Loading settings...</div>;

  return (
    <div className="max-w-2xl space-y-8 animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-black text-slate-900 tracking-tight">Platform Settings</h2>
        <p className="text-slate-500 font-medium">Configure global annotation parameters</p>
      </div>

      <form onSubmit={handleSave} className="bg-white p-10 rounded-3xl shadow-sm border border-slate-200 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-2">
            <label className="block text-sm font-bold text-slate-700 uppercase tracking-wider">Total Annotation Target</label>
            <input
              type="number"
              className="w-full px-5 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-primary/20 focus:bg-white outline-none transition-all font-bold text-slate-900"
              value={config.total_target}
              onChange={(e) => setConfig({ ...config, total_target: parseInt(e.target.value) })}
            />
            <p className="text-xs text-slate-400 font-medium italic">Target number of unique articles to complete.</p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-slate-700 uppercase tracking-wider">Annotators Per Article</label>
            <input
              type="number"
              className="w-full px-5 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-primary/20 focus:bg-white outline-none transition-all font-bold text-slate-900"
              value={config.annotators_per_article}
              onChange={(e) => setConfig({ ...config, annotators_per_article: parseInt(e.target.value) })}
            />
            <p className="text-xs text-slate-400 font-medium italic">Number of annotations required for a 'complete' status.</p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-bold text-slate-700 uppercase tracking-wider">Gold Standard Article IDs</label>
          <textarea
            className="w-full px-5 py-4 rounded-xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-primary/20 focus:bg-white outline-none h-40 font-mono text-sm leading-relaxed transition-all text-slate-700"
            placeholder="ART_001, ART_005, ART_012..."
            value={goldInput}
            onChange={(e) => setGoldInput(e.target.value)}
          />
          <p className="text-xs text-slate-400 font-medium italic leading-relaxed">
            Comma-separated list of article IDs used for reliability checks. Two will be randomly injected into each student's session.
          </p>
        </div>

        <div className="flex items-center justify-between pt-6 border-t border-slate-100">
          {success && (
            <div className="text-green-600 flex items-center gap-2 font-black text-sm animate-in fade-in slide-in-from-left-4">
              <CheckCircle2 size={20} /> SETTINGS UPDATED
            </div>
          )}
          <button
            type="submit"
            disabled={saving}
            className="ml-auto bg-primary text-white px-10 py-4 rounded-2xl font-black hover:bg-primary-dark transition-all flex items-center gap-3 shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" size={24} /> : <Save size={24} />}
            Save Platform Config
          </button>
        </div>
      </form>
    </div>
  );
}
