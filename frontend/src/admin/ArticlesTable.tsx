import { useState, useEffect, useCallback } from "react";
import { collection, query, orderBy, limit, getDocs, doc, updateDoc, where, startAfter, getCountFromServer, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { Article } from "../types";
import { Search, Filter, ChevronLeft, ChevronRight, Eye, Star, MoreVertical, Loader2, ArrowRight, ArrowLeft } from "lucide-react";

const PAGE_SIZE = 10;

export default function ArticlesTable() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  
  // Pagination State
  const [lastVisible, setLastVisible] = useState<any>(null);
  const [firstVisible, setFirstVisible] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);

  // Fetch total count and unique categories once
  useEffect(() => {
    async function fetchMetadata() {
      try {
        const summaryRef = doc(db, "stats", "platform_summary");
        const summarySnap = await getDoc(summaryRef);

        
        if (summarySnap.exists()) {
          const data = summarySnap.data();
          setTotalCount(data.totalArticles || 0);
          
          if (data.categoryDistribution) {
            setCategories(Object.keys(data.categoryDistribution).sort());
          }
        } else {
          // Fallback if summary doesn't exist
          const countSnap = await getCountFromServer(collection(db, "articles"));
          setTotalCount(countSnap.data().count);
        }
      } catch (err) {
        console.error("Error fetching metadata:", err);
      }
    }
    fetchMetadata();
  }, []);

  const fetchArticles = useCallback(async (direction: 'next' | 'prev' | 'initial' = 'initial') => {
    setLoading(true);
    try {
      let q;
      const baseConstraints = [orderBy("article_id")];
      
      if (selectedCategory !== "All") {
        baseConstraints.push(where("category", "==", selectedCategory) as any);
      }

      if (direction === 'next' && lastVisible) {
        q = query(collection(db, "articles"), ...baseConstraints, startAfter(lastVisible), limit(PAGE_SIZE));
      } else if (direction === 'prev' && firstVisible) {
        // Firebase doesn't have limitToLast in the same way for simple paging
        // So we'll fetch based on page state or use the simplest approach for MVP
        // Note: Real cursor-based backward paging is complex in Firestore.
        // We'll use a simpler version for this implementation.
        const skipCount = (page - 2) * PAGE_SIZE;
        q = query(collection(db, "articles"), ...baseConstraints, limit(skipCount + PAGE_SIZE));
      } else {
        q = query(collection(db, "articles"), ...baseConstraints, limit(PAGE_SIZE));
      }

      const snap = await getDocs(q);
      const docs = snap.docs;
      
      if (direction === 'prev') {
        const pageDocs = docs.slice(-PAGE_SIZE);
        setArticles(pageDocs.map(d => d.data() as Article));
        setFirstVisible(pageDocs[0]);
        setLastVisible(pageDocs[pageDocs.length - 1]);
        setHasMore(true);
      } else {
        setArticles(docs.map(d => d.data() as Article));
        setFirstVisible(docs[0]);
        setLastVisible(docs[docs.length - 1]);
        setHasMore(docs.length === PAGE_SIZE);
      }
    } catch (err) {
      console.error("Error fetching articles:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, lastVisible, firstVisible, page]);

  useEffect(() => {
    setPage(1);
    setLastVisible(null);
    setFirstVisible(null);
    fetchArticles('initial');
  }, [selectedCategory]);

  const handleNext = () => {
    if (hasMore) {
      setPage(prev => prev + 1);
      fetchArticles('next');
    }
  };

  const handlePrev = () => {
    if (page > 1) {
      setPage(prev => prev - 1);
      fetchArticles('prev');
    }
  };

  const toggleGoldStandard = async (article: Article) => {
    try {
      const articleRef = doc(db, "articles", article.article_id);
      await updateDoc(articleRef, { is_gold_standard: !article.is_gold_standard });
      setArticles(articles.map(a => 
        a.article_id === article.article_id ? { ...a, is_gold_standard: !a.is_gold_standard } : a
      ));
    } catch (err) {
      alert("Error updating article: " + err);
    }
  };

  const updateGoldLabel = async (articleId: string, label: string) => {
    try {
      const articleRef = doc(db, "articles", articleId);
      await updateDoc(articleRef, { gold_expected_label: label });
      setArticles(articles.map(a => 
        a.article_id === articleId ? { ...a, gold_expected_label: label as any } : a
      ));
      if (selectedArticle?.article_id === articleId) {
        setSelectedArticle({ ...selectedArticle, gold_expected_label: label as any });
      }
    } catch (err) {
      alert("Error updating gold label: " + err);
    }
  };

  const filteredArticles = articles.filter(a => {
    const matchesSearch = a.article_id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          a.headline.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "All" || a.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "complete": return "bg-green-100 text-green-700 border-green-200";
      case "partial": return "bg-yellow-100 text-yellow-700 border-yellow-200";
      case "needs_review": return "bg-orange-100 text-orange-700 border-orange-200";
      default: return "bg-slate-100 text-slate-500 border-slate-200";
    }
  };

  return (
    <div className="space-y-10 animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <h2 className="text-4xl font-black text-slate-900 tracking-tighter italic uppercase">Articles</h2>
          <p className="text-slate-400 font-bold text-xs uppercase tracking-[0.2em]">Dataset Management</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="relative group">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-primary transition-colors" size={20} />
            <input
              type="text"
              placeholder="Search dataset..."
              className="pl-14 pr-6 py-4 rounded-2xl bg-white border border-slate-100 focus:ring-4 focus:ring-primary/5 focus:border-primary/20 outline-none w-80 transition-all shadow-xl shadow-slate-200/40 font-bold text-slate-700 placeholder:text-slate-300"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <select 
            className="px-8 py-4 rounded-2xl bg-white border border-slate-100 focus:ring-4 focus:ring-primary/5 focus:border-primary/20 outline-none transition-all shadow-xl shadow-slate-200/40 font-black text-[10px] uppercase tracking-widest text-slate-500 appearance-none cursor-pointer hover:bg-slate-50"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
          >
            <option value="All">All Categories</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-white rounded-[40px] shadow-2xl shadow-slate-200/40 border border-slate-50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50/30 border-b border-slate-50">
              <tr>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">ID</th>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Article Content</th>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Topic</th>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-center">Progress</th>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Status</th>
                <th className="px-10 py-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-8 py-20 text-center">
                    <Loader2 className="animate-spin inline mr-3 text-primary" size={32} />
                    <span className="text-slate-500 font-black uppercase tracking-widest text-sm">Loading articles...</span>
                  </td>
                </tr>
              ) : filteredArticles.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-8 py-20 text-center">
                    <p className="text-slate-400 font-bold text-lg italic">No articles found matching your criteria.</p>
                  </td>
                </tr>
              ) : (
                filteredArticles.map((article) => (
                  <tr key={article.article_id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="px-8 py-5 font-mono text-xs font-black text-slate-400">{article.article_id}</td>
                    <td className="px-8 py-5">
                      <div className="max-w-xs truncate font-bold text-slate-800 group-hover:text-primary transition-colors" title={article.headline}>
                        {article.headline}
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className="text-xs font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-lg uppercase">{article.category}</span>
                    </td>
                    <td className="px-8 py-5">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-sm font-black text-slate-900">{article.annotation_count}/10</span>
                        <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                          <div 
                            className="h-full bg-primary shadow-[0_0_8px_rgba(37,99,235,0.4)] transition-all duration-700" 
                            style={{ width: `${(article.annotation_count / 10) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-[0.1em] border shadow-sm ${getStatusColor(article.status)}`}>
                        {article.status}
                      </span>
                    </td>
                    <td className="px-8 py-5 text-right">
                      <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0">
                        <button 
                          onClick={() => setSelectedArticle(article)}
                          className="w-10 h-10 flex items-center justify-center bg-white hover:bg-primary hover:text-white rounded-xl text-slate-400 transition-all shadow-sm border border-slate-200"
                          title="View Details"
                        >
                          <Eye size={18} />
                        </button>
                        <button 
                          onClick={() => toggleGoldStandard(article)}
                          className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all shadow-sm border ${
                            article.is_gold_standard 
                              ? "bg-amber-500 text-white border-amber-600 shadow-amber-200" 
                              : "bg-white text-slate-400 border-slate-200 hover:border-amber-500 hover:text-amber-500"
                          }`}
                          title={article.is_gold_standard ? "Remove Gold Standard" : "Mark as Gold Standard"}
                        >
                          <Star size={18} fill={article.is_gold_standard ? "currentColor" : "none"} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <div className="px-8 py-4 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">
            Page {page} {totalCount > 0 && `of ${Math.ceil(totalCount / PAGE_SIZE)}`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrev}
              disabled={page === 1 || loading}
              className="p-2 rounded-xl border border-slate-200 bg-white text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50 transition-all shadow-sm"
              title="Previous Page"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={handleNext}
              disabled={!hasMore || loading}
              className="p-2 rounded-xl border border-slate-200 bg-white text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50 transition-all shadow-sm"
              title="Next Page"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedArticle && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-xl font-bold text-slate-800">Article Details</h3>
              <button 
                onClick={() => setSelectedArticle(null)}
                className="p-2 hover:bg-slate-200 rounded-full transition-colors"
              >
                <ChevronRight className="rotate-45" size={24} />
              </button>
            </div>
            <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-6">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Metadata</label>
                  <div className="mt-2 grid grid-cols-2 gap-4">
                    <div className="bg-slate-50 p-3 rounded-xl">
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Article ID</p>
                      <p className="font-mono font-bold text-slate-700">{selectedArticle.article_id}</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-xl">
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Source</p>
                      <p className="font-bold text-slate-700">{selectedArticle.source}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Headline (Urdu)</label>
                  <p className="mt-2 font-urdu text-xl text-right bg-slate-50 p-4 rounded-xl" dir="rtl">
                    {selectedArticle.headline}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Bias Score</label>
                    <p className={`text-2xl font-bold mt-1 ${
                      (selectedArticle.bias_score || 0) > 3.5 ? "text-red-500" : 
                      (selectedArticle.bias_score || 0) > 1.5 ? "text-amber-500" : "text-green-500"
                    }`}>
                      {selectedArticle.bias_score?.toFixed(2) || "N/A"}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Fleiss' Kappa</label>
                    <p className="text-2xl font-bold mt-1 text-slate-700">
                      {selectedArticle.fleiss_kappa?.toFixed(3) || "N/A"}
                    </p>
                  </div>
                </div>

                {selectedArticle.is_gold_standard && (
                  <div className="bg-amber-50 p-6 rounded-2xl border border-amber-100 space-y-3">
                    <div className="flex items-center gap-2 text-amber-700">
                      <Star size={18} fill="currentColor" />
                      <span className="text-xs font-black uppercase tracking-wider">Gold Standard Configuration</span>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-amber-600 uppercase mb-2 block">Expected Bias Label</label>
                      <select 
                        className="w-full bg-white border border-amber-200 rounded-xl px-4 py-2 text-sm font-bold text-amber-900 outline-none focus:ring-2 focus:ring-amber-500/20"
                        value={selectedArticle.gold_expected_label || ""}
                        onChange={(e) => updateGoldLabel(selectedArticle.article_id, e.target.value)}
                      >
                        <option value="">Select Expected Label...</option>
                        <option value="neutral">Neutral</option>
                        <option value="slightly_manipulative">Slightly Manipulative</option>
                        <option value="highly_manipulative">Highly Manipulative</option>
                      </select>
                      {!selectedArticle.gold_expected_label && (
                        <p className="text-[10px] text-red-500 font-bold mt-2">
                          ⚠️ Missing expected label! Students will always fail this check.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Display Text (Annotator View)</label>
                <div className="mt-2 font-urdu text-lg leading-[2.2] text-right bg-slate-50 p-6 rounded-2xl border border-slate-100 h-[300px] overflow-y-auto" dir="rtl">
                  {selectedArticle.display_text}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
