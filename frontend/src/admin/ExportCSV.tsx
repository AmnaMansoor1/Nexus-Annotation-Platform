import { useState } from "react";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { Article } from "../types";
import { downloadCSV } from "../utils/csvExport";
import { DEFAULT_REQUIRED_ANNOTATIONS } from "../utils/annotationConfig";
import { calculateOverallFleissKappa, calculatePercentAgreement, BiasCounts } from "../utils/calculateKappa";
import { calculateBiasScore } from "../utils/calculateBiasScore";
import { Download, Loader2, FileJson, Table } from "lucide-react";


export default function ExportCSV() {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const ANNOTATOR_COLUMNS = DEFAULT_REQUIRED_ANNOTATIONS;

      // ── B-OPTION 1: Deleted annotator filtering ───────────────────────────
      // Fetch the set of annotator emails whose /annotators doc still EXISTS.
      const annotatorsSnap = await getDocs(collection(db, "annotators"));
      const liveAnnotatorEmails = new Set<string>();
      annotatorsSnap.forEach((d) => {
        const dEmail = (d.data() as any)?.email;
        if (typeof dEmail === "string") liveAnnotatorEmails.add(dEmail.toLowerCase().trim());
      });
      console.log(`[ExportCSV] Live annotators: ${liveAnnotatorEmails.size}.`);

      const q = query(collection(db, "articles"), orderBy("sequence_number"));
      const snap = await getDocs(q);
      const articles = snap.docs.map(d => d.data() as Article);

      const exportData = await Promise.all(articles.map(async (article) => {
        const responsesSnap = await getDocs(
          collection(db, "annotations", article.article_id, "responses")
        );
        const allResponses = responsesSnap.docs.map(d => d.data());

        // Filter out deleted annotators
        const responses = allResponses.filter((res: any) => {
          const rEmail = typeof res.annotator_email === "string"
            ? res.annotator_email.toLowerCase().trim()
            : null;
          if (!rEmail) return false;
          return liveAnnotatorEmails.has(rEmail);
        });
        if (allResponses.length > responses.length) {
          console.log(`[ExportCSV] Article ${article.article_id}: excluded ${allResponses.length - responses.length} response(s) from deleted annotators.`);
        }

        const REQUIRED = DEFAULT_REQUIRED_ANNOTATIONS;

        const row: any = {};
        row.sequence_number = typeof (article as any).sequence_number === "number"
          ? (article as any).sequence_number : "";
        row.article_id   = article.article_id || "";
        row.headline     = article.headline || "";
        row.source       = article.source || "";
        row.author       = article.author || "";
        row.date_published = article.date_published || "";
        row.url          = article.url || "";
        row.category     = article.category || "";
        row.article_type = article.article_type || "";
        row.word_count   = article.word_count || 0;
        row.display_text = article.display_text || "";
        row.status       = article.status || "";

        // ── Scoring block ──────────────────────────────────────────────────
        // For complete articles we ALWAYS derive scores from live filtered
        // responses when stored Firestore values are null/stale (happens when
        // bias_score was never written, or was cleared by a repair pass that
        // forgot to recompute).
        if (
          article.status === "complete" &&
          typeof article.annotation_count === "number" &&
          article.annotation_count >= REQUIRED
        ) {
          const liveCounts: BiasCounts = { neutral: 0, slightly: 0, highly: 0 };
          for (const res of responses as any[]) {
            const lbl = String(res.label || "");
            if (lbl === "neutral")               liveCounts.neutral++;
            else if (lbl === "slightly_manipulative") liveCounts.slightly++;
            else if (lbl === "highly_manipulative")   liveCounts.highly++;
          }
          const liveN = liveCounts.neutral + liveCounts.slightly + liveCounts.highly;

          if (liveN >= REQUIRED) {
            // bias_score: stored value preferred; recompute when null
            row.bias_score = (article.bias_score != null)
              ? article.bias_score
              : calculateBiasScore(liveCounts);

            // percent_agreement: stored value preferred; recompute when null
            row.percent_agreement = (article.percent_agreement != null)
              ? article.percent_agreement
              : calculatePercentAgreement(liveCounts);

            // label (binary 0/1): stored value preferred; derive from bias_score when null
            if (article.label === 0 || article.label === 1) {
              row.label = article.label;
            } else {
              row.label = (row.bias_score as number) >= 2.5 ? 1 : 0;
            }
          } else {
            // Fewer live responses than REQUIRED after filtering deleted annotators
            row.bias_score        = "";
            row.percent_agreement = "";
            row.label             = "";
          }
        } else {
          // Article not complete yet
          row.bias_score        = "";
          row.percent_agreement = "";
          row.label             = (article.label === 0 || article.label === 1) ? article.label : "";
        }

        row.total_annotations = responses.length;

        for (let i = 1; i <= ANNOTATOR_COLUMNS; i++) {
          row[`ann_${i}_student_id`]       = "";
          row[`ann_${i}_label`]            = "";
          row[`manipulation_cue_ann_${i}`] = "";
        }

        responses.forEach((res: any, i) => {
          if (i < ANNOTATOR_COLUMNS) {
            const slot = i + 1;
            row[`ann_${slot}_student_id`]       = res.annotator_email || "unknown";
            row[`ann_${slot}_label`]            = res.label || "";
            const cues: string[] = Array.isArray(res.manipulation_cues) ? res.manipulation_cues : [];
            row[`manipulation_cue_ann_${slot}`] = cues.join("|");
          }
        });

        return row;
      }));

      // ── Dataset-wide Fleiss' Kappa summary row ─────────────────────────────
      const REQUIRED = DEFAULT_REQUIRED_ANNOTATIONS;
      const completedCountsArray: BiasCounts[] = [];
      for (const article of articles) {
        if (article.status !== "complete") continue;
        if (typeof article.annotation_count !== "number" || article.annotation_count < REQUIRED) continue;
        try {
          const rSnap = await getDocs(
            collection(db, "annotations", article.article_id, "responses")
          );
          const liveFiltered = rSnap.docs
            .map(d => d.data() as any)
            .filter((res: any) => {
              const e = typeof res.annotator_email === "string"
                ? res.annotator_email.toLowerCase().trim() : "";
              return !!e && liveAnnotatorEmails.has(e);
            });
          const counts: BiasCounts = { neutral: 0, slightly: 0, highly: 0 };
          for (const res of liveFiltered) {
            const lbl = String(res?.label || "");
            if (lbl === "neutral")                   counts.neutral++;
            else if (lbl === "slightly_manipulative") counts.slightly++;
            else if (lbl === "highly_manipulative")   counts.highly++;
          }
          const n = counts.neutral + counts.slightly + counts.highly;
          if (n === REQUIRED) completedCountsArray.push(counts);
        } catch (e) {
          console.warn(`[ExportCSV] Skipping kappa for ${article.article_id}:`, e);
        }
      }

      const overallKappa = calculateOverallFleissKappa(completedCountsArray);
      if (completedCountsArray.length > 0) {
        const summaryRow: any = {};
        summaryRow.sequence_number   = "";
        summaryRow.article_id        = "OVERALL_DATASET_KAPPA";
        summaryRow.headline          = `Dataset-wide Fleiss' Kappa across ${completedCountsArray.length} complete articles (n=${DEFAULT_REQUIRED_ANNOTATIONS} raters each)`;
        summaryRow.source            = "";
        summaryRow.author            = "";
        summaryRow.date_published    = "";
        summaryRow.url               = "";
        summaryRow.category          = "";
        summaryRow.article_type      = "";
        summaryRow.word_count        = completedCountsArray.length;
        summaryRow.display_text      = "";
        summaryRow.status            = "summary";
        summaryRow.bias_score        = "";
        summaryRow.percent_agreement = "";
        summaryRow.label             = "";
        // Overall dataset Fleiss' kappa in its own clearly-named column
        summaryRow.fleiss_kappa      = overallKappa;
        summaryRow.total_annotations = completedCountsArray.length;
        for (let i = 1; i <= ANNOTATOR_COLUMNS; i++) {
          summaryRow[`ann_${i}_student_id`]       = "";
          summaryRow[`ann_${i}_label`]            = "";
          summaryRow[`manipulation_cue_ann_${i}`] = "";
        }
        exportData.push(summaryRow);
        console.log(`[ExportCSV] Overall Fleiss kappa = ${overallKappa} from ${completedCountsArray.length} articles.`);
      } else {
        console.log(`[ExportCSV] No complete articles with exactly ${REQUIRED} live raters — skipping kappa row.`);
      }

      downloadCSV(exportData, `NEXUS_Export_${new Date().toISOString().split("T")[0]}.csv`);
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
              Export all articles including their original metadata, processed scores (Bias Score, Fleiss&#39; Kappa),
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
