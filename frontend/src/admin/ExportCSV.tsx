import { useState } from "react";
import { collection, getDocs, query, orderBy, writeBatch, doc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Article } from "../types";
import { downloadCSV } from "../utils/csvExport";
import { Download, Loader2, FileJson, Table, Trash2 } from "lucide-react";

export default function ExportCSV() {
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "articles"), orderBy("article_id"));
      const snap = await getDocs(q);
      const articles = snap.docs.map(doc => doc.data() as Article);

      const exportData = await Promise.all(articles.map(async (article) => {
        // Fetch all responses for this article
        const responsesSnap = await getDocs(collection(db, "annotations", article.article_id, "responses"));
        const responses = responsesSnap.docs.map(d => d.data());

        // 1. Base article data
        const row: any = {
          article_id: article.article_id || "",
          headline: article.headline || "",
          source: article.source || "",
          author: article.author || "",
          date_published: article.date_published || "",
          url: article.url || "",
          category: article.category || "",
          article_type: article.article_type || "",
          word_count: article.word_count || 0,
          display_text: article.display_text || "",
          status: article.status || "",
          bias_score: article.bias_score || "",
          fleiss_kappa: article.fleiss_kappa || "",
          total_annotations: article.annotation_count || responses.length
        };

        // 2. Pre-initialize all 10 annotator slots to ensure columns always exist in order
        for (let i = 1; i <= 10; i++) {
          row[`ann_${i}_student_id`] = "";
          row[`ann_${i}_label`] = "";
        }

        // 3. Fill in actual response data
        responses.forEach((res, i) => {
          if (i < 10) {
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

  const handleDeleteAllArticles = async () => {
    if (!window.confirm("Are you sure you want to DELETE ALL articles? This cannot be undone!")) return;
    setDeleteLoading(true);
    try {
      // Use batches to delete all articles (Firestore limit is 500 per batch)
      const articlesSnap = await getDocs(collection(db, "articles"));
      const batchSize = 500;
      const articles = articlesSnap.docs;
      for (let i = 0; i < articles.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = articles.slice(i, i + batchSize);
        chunk.forEach((doc) => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }

      alert(`Successfully deleted ${articles.length} articles!`);
    } catch (err) {
      alert("Delete failed: " + err);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Export Dataset</h2>
        <p className="text-slate-500">Download the complete annotated dataset</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 space-y-6">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
            <Table size={32} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-slate-800">Full Dataset (CSV)</h3>
            <p className="text-slate-500 text-sm leading-relaxed">
              Export all articles including their original metadata, processed scores (Bias Score, Fleiss' Kappa), 
              and individual labels from up to 10 annotators per article.
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

        <div className="bg-red-50 p-8 rounded-2xl shadow-sm border border-red-200 space-y-6">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center">
            <Trash2 size={32} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-red-900">Delete All Articles</h3>
            <p className="text-red-600 text-sm leading-relaxed">
              Permanently delete ALL articles from the database (cannot be undone). Use this to reset the article library before importing the new CSV.
            </p>
          </div>
          <button
            onClick={handleDeleteAllArticles}
            disabled={deleteLoading}
            className="w-full bg-red-600 text-white py-4 rounded-xl font-bold hover:bg-red-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-red-200"
          >
            {deleteLoading ? <Loader2 className="animate-spin" size={20} /> : <Trash2 size={20} />}
            Delete All Articles
          </button>
        </div>
      </div>
    </div>
  );
}
