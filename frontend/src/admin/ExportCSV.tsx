import { useState } from "react";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { Article } from "../types";
import { downloadCSV } from "../utils/csvExport";
import { DEFAULT_REQUIRED_ANNOTATIONS } from "../utils/annotationConfig";
import { Download, Loader2, FileJson, Table } from "lucide-react";

export default function ExportCSV() {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      // Canonical annotator count comes from a single shared constant in annotationConfig.ts.
      // To change for the whole platform: edit DEFAULT_REQUIRED_ANNOTATIONS, rebuild, redeploy via CLI.
      // No runtime admin config for this value — keeps it simple and consistent.
      const ANNOTATOR_COLUMNS = DEFAULT_REQUIRED_ANNOTATIONS;

      // ── B-OPTION 1: Deleted annotator filtering ──────────────────────────────
      // Fetch the set of annotator emails whose /annotators doc still EXISTS.
      // An annotator deleted (hard-deleted) via AnnotatorsTable no longer has a
      // doc here, so their labels are excluded from the exported dataset entirely.
      // This matches the requirement: "if I delete any annotator from db then it
      // should be deleted from exported csv too."
      const annotatorsSnap = await getDocs(collection(db, "annotators"));
      const liveAnnotatorEmails = new Set<string>();
      annotatorsSnap.forEach((d) => {
        const dEmail = (d.data() as any)?.email;
        if (typeof dEmail === "string") liveAnnotatorEmails.add(dEmail.toLowerCase().trim());
      });
      console.log(`[ExportCSV] Live annotators in /annotators: ${liveAnnotatorEmails.size}. Annotations from any other email will be excluded.`);

      const q = query(collection(db, "articles"), orderBy("sequence_number"));
      const snap = await getDocs(q);
      const articles = snap.docs.map(d => d.data() as Article);

      const exportData = await Promise.all(articles.map(async (article) => {
        const responsesSnap = await getDocs(collection(db, "annotations", article.article_id, "responses"));
        const allResponses = responsesSnap.docs.map(d => d.data());

        // ── Filter out deleted annotators ────────────────────────────────────
        // Only responses whose annotator_email still has a live /annotators doc
        // are written to the CSV. Deleted annotators' contributions are excluded
        // from BOTH the student_id/label slots AND the total_annotations count.
        const responses = allResponses.filter((res: any) => {
          const rEmail = typeof res.annotator_email === "string"
            ? res.annotator_email.toLowerCase().trim()
            : null;
          if (!rEmail) return false; // malformed response — drop
          if (!liveAnnotatorEmails.has(rEmail)) return false; // annotator deleted — skip
          return true;
        });
        const droppedCount = allResponses.length - responses.length;
        if (droppedCount > 0) {
          console.log(`[ExportCSV] Article ${article.article_id}: excluded ${droppedCount} response(s) from deleted/unknown annotators.`);
        }

        const row: any = {};
        if (typeof (article as any).sequence_number === "number") {
          row.sequence_number = (article as any).sequence_number;
        } else {
          row.sequence_number = "";
        }
        row.article_id = article.article_id || "";
        row.headline = article.headline || "";
        row.source = article.source || "";
        row.author = article.author || "";
        row.date_published = article.date_published || "";
        row.url = article.url || "";
        row.category = article.category || "";
        row.article_type = article.article_type || "";
        row.word_count = article.word_count || 0;
        row.display_text = article.display_text || "";
        row.status = article.status || "";
        row.bias_score = article.bias_score || "";
        row.fleiss_kappa = article.fleiss_kappa || "";
        // Use the FILTERED response count (after deleting annotators) as the
        // canonical total. This matches the slot values so totals stay consistent
        // and the exported dataset accurately reflects only current annotators.
        row.total_annotations = responses.length;

        // Exactly ANNOTATOR_COLUMNS slots (default 5 per locked spec).
        // No extra empty columns — consistent with the "exactly N annotators per article" requirement.
        for (let i = 1; i <= ANNOTATOR_COLUMNS; i++) {
          row[`ann_${i}_student_id`] = "";
          row[`ann_${i}_label`] = "";
        }

        responses.forEach((res: any, i) => {
          if (i < ANNOTATOR_COLUMNS) {
            const slot = i + 1;
            row[`ann_${slot}_student_id`] = res.annotator_email || "unknown";
            row[`ann_${slot}_label`] = res.label || "";
          }
        });

        return row;
      }));

      downloadCSV(exportData, `NEXUS_Export_${new Date().toISOString().split('T')[0]}.csv`);
    } catch (err) {
      alert("Export failed: " + err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Export Dataset</h2>
        <p className="text-slate-500">Download the complete annotated dataset</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 space-y-6">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
            <Table size={32} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-slate-800">Full Dataset (CSV)</h3>
            <p className="text-slate-500 text-sm leading-relaxed">
              Export all articles including their original metadata, processed scores (Bias Score, Fleiss' Kappa), 
              and individual labels from exactly {DEFAULT_REQUIRED_ANNOTATIONS} annotators per article.
              <span className="block mt-1 text-xs opacity-70">
                (Constant defined in <code>annotationConfig.ts</code>. Change via CLI: edit constant, rebuild, redeploy.)
              </span>
            </p>
          </div>
          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full bg-primary text-white py-4 rounded-xl font-bold hover:bg-primary/90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-primary/20"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : <Download size={20} />}
            Download Full CSV
          </button>
        </div>

        <div className="bg-slate-900 p-8 rounded-2xl shadow-xl border border-slate-800 space-y-6">
          <div className="w-16 h-16 bg-slate-800 text-slate-400 rounded-2xl flex items-center justify-center">
            <FileJson size={32} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-white">JSON Export</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              For advanced research processing. Contains the full nested structure of annotations and annotator metadata.
            </p>
          </div>
          <button
            disabled
            className="w-full bg-slate-800 text-slate-500 py-4 rounded-xl font-bold cursor-not-allowed flex items-center justify-center gap-2"
          >
            Coming Soon
          </button>
        </div>
      </div>
    </div>
  );
}
