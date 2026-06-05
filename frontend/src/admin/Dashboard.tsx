import { useState, useEffect } from "react";
import { collection, query, getDocs, limit, doc, where, getCountFromServer, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Article, PlatformSummary } from "../types";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { 
  Newspaper, 
  CheckCircle2, 
  Clock, 
  Users, 
  TrendingUp,
  Activity,
  Loader2
} from "lucide-react";

export default function Dashboard() {
  const [stats, setStats] = useState<PlatformSummary>({
    totalArticles: 0,
    completedArticles: 0,
    inProgressArticles: 0,
    pendingArticles: 0,
    totalAnnotators: 0,
    completedAnnotators: 0,
    avgBiasScore: 0,
    needsReview: 0
  });

  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [statusData, setStatusData] = useState<any[]>([
    { name: "Completed", value: 0, color: "#16a34a" },
    { name: "In Progress", value: 0, color: "#eab308" },
    { name: "Pending", value: 0, color: "#94a3b8" }
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboardData() {
      setLoading(true);
      setError(null);
      try {
        console.log("Loading dashboard data from summary...");
        
        // Scalable approach: Read from the single summary document
        const summaryRef = doc(db, "stats", "platform_summary");
        const summarySnap = await getDoc(summaryRef);
        
        if (!summarySnap.exists()) {
          throw new Error("Stats summary not found. Please upload articles first.");
        }

        const data = summarySnap.data() as PlatformSummary;
        setStats(data);
        
        setStatusData([
          { name: "Completed", value: data.completedArticles || 0, color: "#16a34a" },
          { name: "In Progress", value: data.inProgressArticles || 0, color: "#eab308" },
          { name: "Pending", value: data.pendingArticles || 0, color: "#94a3b8" }
        ]);
        
        // 2. Extract categories from summary distribution
        if (data.categoryDistribution) {
          setCategoryData(Object.entries(data.categoryDistribution)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
          );
        }
        
      } catch (err) {
        console.error("Dashboard data load error:", err);
        setError("Failed to load dashboard data. Please check your Firestore connection and refresh.");
      } finally {
        setLoading(false);
      }
    }

    loadDashboardData();
  }, []);


  const statCards = [
    { label: "Total Articles", value: stats.totalArticles, icon: Newspaper, color: "bg-blue-500" },
    { label: "Fully Annotated", value: stats.completedArticles, icon: CheckCircle2, color: "bg-green-500" },
    { label: "In Progress", value: stats.inProgressArticles, icon: Clock, color: "bg-yellow-500" },
    { label: "Pending", value: stats.pendingArticles, icon: TrendingUp, color: "bg-slate-400" },
    { label: "Total Annotators", value: stats.totalAnnotators, icon: Users, color: "bg-purple-500" },
    { label: "Annotators Completed", value: stats.completedAnnotators, icon: Activity, color: "bg-teal-500" },
  ];

  if (loading) {
    return (
      <div className="bg-white p-10 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-center gap-3 text-slate-500">
        <Loader2 className="animate-spin text-primary" size={24} />
        <span className="font-medium">Loading dashboard...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 p-6 rounded-2xl border border-red-200 text-red-700 space-y-2">
        <h2 className="text-lg font-bold">Admin Dashboard Unavailable</h2>
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h2>
          <p className="text-slate-500 font-medium text-sm">Platform Metrics & Analytics</p>
        </div>
        <div className="flex items-center gap-3 bg-white px-5 py-2.5 rounded-xl border border-slate-100 shadow-sm">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">System Live</span>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((card, i) => (
          <div key={i} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-4 hover:shadow-md transition-all group relative overflow-hidden">
            <div className={`${card.color} w-12 h-12 rounded-xl text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform`}>
              <card.icon size={24} />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">{card.label}</p>
              <p className="text-3xl font-bold text-slate-900">{card.value.toLocaleString()}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Category Bar Chart */}
        <div className="bg-white p-10 rounded-[40px] shadow-xl shadow-slate-200/40 border border-slate-50">
          <div className="mb-8">
            <h3 className="text-xl font-black text-slate-900 tracking-tight uppercase">Article Distribution</h3>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Volume by Topic Category</p>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData} margin={{ top: 20, right: 30, left: 20, bottom: 70 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="value" fill="#3b82f6" radius={[6, 6, 0, 0]} barSize={40} label={{ position: 'top', fill: '#64748b', fontSize: 10, fontWeight: 'bold' }}>
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={['#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a'][index % 5]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Status Pie Chart */}
        <div className="bg-white p-10 rounded-[40px] shadow-xl shadow-slate-200/40 border border-slate-50">
          <div className="mb-8">
            <h3 className="text-xl font-black text-slate-900 tracking-tight uppercase">Progress Overview</h3>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Live Annotation Status</p>
          </div>
          <div className="h-80 flex flex-col items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={8}
                  dataKey="value"
                  stroke="none"
                  label={({ name, value }) => value > 0 ? `${name}: ${value}` : ''}
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

    </div>
  );
}
