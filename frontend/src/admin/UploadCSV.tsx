import { useState } from "react";
import Papa from "papaparse";
import { collection, doc, setDoc, getDoc, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Article } from "../types";
import { updatePlatformStats } from "../utils/stats";
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

export default function UploadCSV() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stats, setStats] = useState({ imported: 0, skipped: 0 });
  const [preview, setPreview] = useState<any[]>([]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        console.log("Parsed CSV data:", results.data);
        // Validate we have article_id on each row
        const invalidRows = results.data.filter((row: any) => !row.article_id);
        if (invalidRows.length > 0) {
          alert(`Error: ${invalidRows.length} row(s) missing 'article_id' column!`);
        }
        setData(results.data);
        setPreview(results.data.slice(0, 5));
      },
      error: (err) => {
        console.error("CSV parsing error:", err);
        alert("Error parsing CSV: " + err.message);
      }
    });
  };

  const handleImport = async () => {
    if (data.length === 0) return;
    setLoading(true);
    let imported = 0;
    let skipped = 0;

    try {
      // Use batches for efficiency (Firestore limit is 500 per batch)
      const batchSize = 100;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = data.slice(i, i + batchSize);
        let chunkImported = 0;

        console.log(`Processing chunk ${i / batchSize + 1}, rows:`, chunk);

        // 1. Pre-check which articles already exist in this chunk (Parallelized)
        const existenceChecks = await Promise.all(chunk.map(async (row) => {
          const articleId = row.article_id;
          if (!articleId) return { row, exists: true }; // Skip empty IDs
          const docSnap = await getDoc(doc(db, "articles", articleId));
          return { row, exists: docSnap.exists() };
        }));

        for (const { row, exists } of existenceChecks) {
          if (exists) {
            skipped++;
            continue;
          }

          const articleId = row.article_id;
          const docRef = doc(db, "articles", articleId);

          // Build article object, only include gold_expected_label if it exists
        const article: any = {
          article_id: articleId,
          headline: row.headline || "",
          display_text: row.display_text || row.full_text || row.summary || "",
          source: row.source || "",
          author: row.author || "",
          date_published: row.date_published || "",
          url: row.url || "",
          category: row.category || "",
          article_type: (row.article_type as any) || "News Article",
          word_count: parseInt(row.word_count) || 0,
          status: "pending",
          annotation_count: 0,
          annotated_by: [],
          assigned_to: [],
          assigned_count: 0,
          bias_score: null,
          fleiss_kappa: null,
          is_gold_standard: row.is_gold_standard === "true" || row.is_gold_standard === "1"
        };
        if (row.gold_expected_label) {
          article.gold_expected_label = row.gold_expected_label;
        }
          console.log("Adding article to batch:", articleId);
          batch.set(docRef, article);
          chunkImported++;
        }

        await batch.commit();
        console.log(`Committed chunk ${i / batchSize + 1}, imported ${chunkImported}`);
        imported += chunkImported;
        setProgress(Math.min(100, Math.round(((i + batchSize) / data.length) * 100)));
        
        // Update platform stats for this chunk
        if (chunkImported > 0) {
          // Calculate category distribution for this chunk
          const categories = chunk.reduce((acc: Record<string, number>, row) => {
            const cat = row.category || "Uncategorized";
            acc[cat] = (acc[cat] || 0) + 1;
            return acc;
          }, {});

          await updatePlatformStats({
            totalArticles: chunkImported,
            pendingArticles: chunkImported,
            categoryDistribution: categories
          });
        }
      }

      setStats({ imported, skipped });
      console.log("Import complete:", { imported, skipped });
    } catch (err: any) {
      console.error("Error importing articles:", err);
      alert("Error importing articles: " + (err.message || JSON.stringify(err)));
    } finally {
      setLoading(false);
      setData([]);
      setPreview([]);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-black text-slate-900 tracking-tight">Upload Articles</h2>
        <p className="text-slate-500 font-medium">Import master dataset from CSV</p>
      </div>

      <div className="bg-white p-12 rounded-3xl shadow-sm border border-slate-200">
        <div className="max-w-xl mx-auto text-center space-y-6">
          <div className="border-2 border-dashed border-slate-200 rounded-3xl p-16 hover:border-primary hover:bg-primary/5 transition-all group cursor-pointer relative">
            <input
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              id="csv-upload"
            />
            <div className="space-y-4">
              <div className="w-20 h-20 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto group-hover:scale-110 transition-transform shadow-sm">
                <Upload size={40} />
              </div>
              <div>
                <p className="text-xl font-black text-slate-900">Click to upload CSV</p>
                <p className="text-slate-500 font-medium mt-1">article_id, headline, display_text, etc.</p>
              </div>
            </div>
          </div>

          {preview.length > 0 && (
            <div className="space-y-6 pt-8">
              <div className="text-left overflow-x-auto border border-slate-100 rounded-xl">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 font-medium">
                    <tr>
                      <th className="px-4 py-3 text-left">ID</th>
                      <th className="px-4 py-3 text-left">Headline</th>
                      <th className="px-4 py-3 text-left">Category</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map((row, i) => (
                      <tr key={i}>
                        <td className="px-4 py-3 font-mono">{row.article_id}</td>
                        <td className="px-4 py-3 truncate max-w-xs">{row.headline}</td>
                        <td className="px-4 py-3">{row.category}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-500">
                  <FileText className="inline mr-2" size={16} />
                  {data.length} rows detected
                </p>
                <button
                  onClick={handleImport}
                  disabled={loading}
                  className="bg-primary text-white px-10 py-4 rounded-2xl font-black hover:bg-primary-dark transition-all flex items-center gap-3 shadow-lg shadow-primary/20 disabled:opacity-50 disabled:shadow-none"
                >
                  {loading ? (
                    <Loader2 className="animate-spin" size={24} />
                  ) : (
                    <>Import to Firestore <CheckCircle2 size={24} /></>
                  )}
                </button>
              </div>
            </div>
          )}

          {loading && (
            <div className="space-y-2">
              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-sm font-bold text-primary">{progress}% Imported</p>
            </div>
          )}

          {stats.imported > 0 || stats.skipped > 0 ? (
            <div className="p-4 rounded-xl bg-green-50 border border-green-100 text-green-700 flex items-center gap-3">
              <CheckCircle2 size={20} />
              <p className="text-sm font-medium">
                Successfully imported {stats.imported} articles. Skipped {stats.skipped} duplicates/invalid rows.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
