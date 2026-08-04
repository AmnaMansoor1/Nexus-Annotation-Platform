import { useState } from "react";
import { collection, getDocsFromServer, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator, Article, BiasLabel } from "../types";
import { downloadCSV } from "../utils/csvExport";
import { formatBinaryBiasLabel, getMajorityBiasLabel, mapBiasLabelToBinary } from "../utils/biasLabels";
import { calculateOverallFleissKappa } from "../utils/calculateKappa";
import { Download, Loader2, FileJson, Table } from "lucide-react";

const TRAINING_ANNOTATOR_SLOTS = 5;

function sortResponsesByTimestamp(responses: Record<string, unknown>[]) {
  return [...responses].sort((a, b) => {
    const aTime = (a.timestamp as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const bTime = (b.timestamp as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    return aTime - bTime;
  });
}

function buildStudentIdLookup(annotators: Annotator[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const annotator of annotators) {
    const email = annotator.email?.toLowerCase().trim();
    if (!email) continue;
    lookup.set(email, annotator.registration_code || annotator.email);
  }
  return lookup;
}

function resolveStudentId(
  annotatorEmail: string | undefined,
  studentIdByEmail: Map<string, string>
): string {
  if (!annotatorEmail) return "";
  return studentIdByEmail.get(annotatorEmail.toLowerCase().trim()) || annotatorEmail;
}

export default function ExportCSV() {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const [articlesSnap, annotatorsSnap] = await Promise.all([
        getDocsFromServer(query(collection(db, "articles"), orderBy("article_id"))),
        getDocsFromServer(collection(db, "annotators")),
      ]);
      const articles = articlesSnap.docs.map(doc => doc.data() as Article);
      const studentIdByEmail = buildStudentIdLookup(
        annotatorsSnap.docs.map(doc => doc.data() as Annotator)
      );

      const exportRows = await Promise.all(articles.map(async (article) => {
        const responsesSnap = await getDocsFromServer(
          collection(db, "annotations", article.article_id, "responses")
        );
        const responses = sortResponsesByTimestamp(responsesSnap.docs.map(d => d.data()));
        const annotationSlots = responses.slice(0, TRAINING_ANNOTATOR_SLOTS);
        const isComplete = annotationSlots.length >= TRAINING_ANNOTATOR_SLOTS;
        const counts = annotationSlots.reduce<{ neutral: number; slightly: number; highly: number }>((acc, res) => {
          const label = res.label as BiasLabel | undefined;
          if (label === "neutral") acc.neutral += 1;
          if (label === "slightly_manipulative") acc.slightly += 1;
          if (label === "highly_manipulative") acc.highly += 1;
          return acc;
        }, { neutral: 0, slightly: 0, highly: 0 });
        const majorityLabel = getMajorityBiasLabel(counts);

        const row: any = {
          article_id: article.article_id || "",
          headline: article.headline || "",
          display_text: article.display_text || "",
          source: article.source || "",
          author: article.author || "",
          date_published: article.date_published || "",
          url: article.url || "",
          category: article.category || "",
          article_type: article.article_type || "",
          word_count: article.word_count || 0,
          label: isComplete ? mapBiasLabelToBinary(majorityLabel) : "",
          final_label: isComplete ? formatBinaryBiasLabel(majorityLabel) : "",
          bias_score: isComplete ? (article.bias_score ?? "") : "",
          fleiss_kappa: isComplete ? (article.fleiss_kappa ?? "") : "",
        };

        for (let i = 1; i <= TRAINING_ANNOTATOR_SLOTS; i++) {
          row[`ann_${i}_student_id`] = "";
          row[`ann_${i}_label`] = "";
        }

        annotationSlots.forEach((res, i) => {
          const slot = i + 1;
          row[`ann_${slot}_student_id`] = resolveStudentId(res.annotator_email as string | undefined, studentIdByEmail);
          row[`ann_${slot}_label`] = (res.label as string) || "";
        });

        return {
          row,
          counts,
          isComplete,
        };
      }));

      const allArticlesComplete =
        exportRows.length > 0 && exportRows.every((entry) => entry.isComplete);
      const completedCounts = exportRows
        .filter((entry) => entry.isComplete)
        .map((entry) => entry.counts);
      const exportData = exportRows.map((entry) => entry.row);

      if (allArticlesComplete && completedCounts.length === exportRows.length) {
        const overallKappaRow: Record<string, string | number> = {
          article_id: "OVERALL_DATASET_KAPPA",
          headline: "",
          display_text: "Dataset-wide Fleiss' kappa across all completed articles",
          source: "",
          author: "",
          date_published: "",
          url: "",
          category: "",
          article_type: "",
          word_count: "",
          label: "",
          final_label: "",
          bias_score: "",
          fleiss_kappa: calculateOverallFleissKappa(completedCounts),
        };

        for (let i = 1; i <= TRAINING_ANNOTATOR_SLOTS; i++) {
          overallKappaRow[`ann_${i}_student_id`] = "";
          overallKappaRow[`ann_${i}_label`] = "";
        }

        exportData.push(overallKappaRow);
      }

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
              Export article metadata, article text, five annotator IDs and labels, binary labels,
              and agreement scores only after the full 5 annotations are complete, plus a final overall-kappa summary row.
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
