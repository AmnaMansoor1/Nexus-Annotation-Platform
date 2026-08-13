import { useState } from "react";
import { collection, getDocsFromServer, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { Annotator, Article, BiasLabel } from "../types";
import { downloadCSV } from "../utils/csvExport";
import { formatBinaryBiasLabel, getMajorityBiasLabel, mapBiasLabelToBinary } from "../utils/biasLabels";
import { calculateBiasScore } from "../utils/calculateBiasScore";
import { calculateFleissKappa, calculateOverallFleissKappa } from "../utils/calculateKappa";
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

      const validAnnotatorEmails = new Set(
        annotatorsSnap.docs
          .map(doc => (doc.data() as Annotator).email?.toLowerCase().trim())
          .filter(Boolean) as string[]
      );

      const exportRows = await Promise.all(articles.map(async (article) => {
        const responsesSnap = await getDocsFromServer(
          collection(db, "annotations", article.article_id, "responses")
        );
        const allResponses = sortResponsesByTimestamp(responsesSnap.docs.map(d => d.data()));
        const responses = allResponses.filter(res => {
          const email = (res.annotator_email as string | undefined)?.toLowerCase().trim();
          if (!email) return false;
          return validAnnotatorEmails.has(email);
        });
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

        // Prefer values stored on the article (written on 5th annotation),
        // fall back to recalculation from responses in case of legacy data.
        const finalStoredLabel = article.final_label ?? majorityLabel;
        const storedLabel = article.label !== null && article.label !== undefined ? article.label : mapBiasLabelToBinary(majorityLabel);
        const storedBiasScore = article.bias_score !== null && article.bias_score !== undefined
          ? article.bias_score
          : (isComplete ? calculateBiasScore(counts) : "");
        const storedFleissKappa = article.fleiss_kappa !== null && article.fleiss_kappa !== undefined
          ? article.fleiss_kappa
          : (isComplete ? calculateFleissKappa(counts) : "");

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
          label: isComplete ? storedLabel : "",
          final_label: isComplete ? formatBinaryBiasLabel(finalStoredLabel) : "",
          majority_vote_label: isComplete ? (finalStoredLabel || "") : "",
          bias_score: isComplete ? storedBiasScore : "",
          fleiss_kappa: isComplete ? storedFleissKappa : "",
        };

        for (let i = 1; i <= TRAINING_ANNOTATOR_SLOTS; i++) {
          row[`ann_${i}_student_id`] = "";
          row[`ann_${i}_label`] = "";
        }

        annotationSlots.forEach((res, i) => {
          const slot = i + 1;
          const annotatorEmail = res.annotator_email as string | undefined;
          row[`ann_${slot}_student_id`] = resolveStudentId(annotatorEmail, studentIdByEmail);
          row[`ann_${slot}_label`] = (res.label as string) || "";
        });

        return {
          row,
          counts,
          isComplete,
        };
      }));

      const completedEntries = exportRows.filter((entry) => entry.isComplete);
      const completedCounts = completedEntries.map((entry) => entry.counts);
      // Export ALL articles (like the previous version). 
      // Incomplete articles show blank label/metrics so you can see in-progress data too.
      const exportData = exportRows.map((entry) => entry.row);

      if (completedEntries.length > 0) {
        const overallKappaRow: Record<string, string | number> = {
          article_id: "OVERALL_DATASET_KAPPA",
          headline: "",
          display_text: `Dataset-wide Fleiss' kappa across ${completedEntries.length} completed articles (5 annotations each)`,
          source: "",
          author: "",
          date_published: "",
          url: "",
          category: "",
          article_type: "",
          word_count: "",
          label: "",
          final_label: "",
          majority_vote_label: "",
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
            <h3 className="text-xl font-bold text-slate-800">Completed Annotations Dataset (CSV)</h3>
            <p className="text-slate-500 text-sm leading-relaxed">
              Export only articles with a full 5 annotations each. Includes article metadata, article text,
              per-annotator student IDs, emails and labels, binary ML label, human-readable final label,
              and agreement scores, plus a final overall Fleiss' kappa summary row.
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
