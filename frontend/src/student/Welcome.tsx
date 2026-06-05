import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export default function Welcome() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-student p-6 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />

      <div className="max-w-3xl w-full text-center space-y-12 relative animate-in fade-in zoom-in-95 duration-700">
        <div className="space-y-4">
          <div className="inline-block px-4 py-1.5 bg-primary/10 text-primary rounded-full text-[10px] font-black uppercase tracking-[0.2em] border border-primary/20 mb-4">
            Research Study Phase 1
          </div>
          <h1 className="text-6xl font-black text-slate-900 tracking-tight leading-tight">
            Can you detect <span className="text-primary italic">manipulation</span> in the news?
          </h1>
        </div>
        
        <p className="text-xl text-slate-500 leading-relaxed max-w-2xl mx-auto font-medium">
          You will be shown 20 Urdu news article excerpts. Your task is to evaluate the 
          tone and writing style of each excerpt honestly.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-left">
          <div className="bg-white p-8 rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 space-y-4 relative overflow-hidden group hover:-translate-y-1 transition-all duration-300">
            <div className="absolute top-0 left-0 w-full h-1 bg-primary/20 group-hover:bg-primary transition-colors" />
            <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center font-black">1</div>
            <h3 className="font-black text-slate-800 uppercase tracking-wider text-xs">Read Carefully</h3>
            <p className="text-sm text-slate-500 leading-relaxed font-medium">Analyze the writing style. Source and author names are hidden to prevent bias.</p>
          </div>

          <div className="bg-white p-8 rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 space-y-4 relative overflow-hidden group hover:-translate-y-1 transition-all duration-300">
            <div className="absolute top-0 left-0 w-full h-1 bg-primary/20 group-hover:bg-primary transition-colors" />
            <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center font-black">2</div>
            <h3 className="font-black text-slate-800 uppercase tracking-wider text-xs">One-Way Flow</h3>
            <p className="text-sm text-slate-500 leading-relaxed font-medium">Each decision is final. You cannot go back to previous articles once submitted.</p>
          </div>

          <div className="bg-white p-8 rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 space-y-4 relative overflow-hidden group hover:-translate-y-1 transition-all duration-300">
            <div className="absolute top-0 left-0 w-full h-1 bg-primary/20 group-hover:bg-primary transition-colors" />
            <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center font-black">3</div>
            <h3 className="font-black text-slate-800 uppercase tracking-wider text-xs">10s Reading</h3>
            <p className="text-sm text-slate-500 leading-relaxed font-medium">The submit button activates after 10 seconds to ensure quality reading.</p>
          </div>
        </div>

        <div className="pt-6">
          <button
            onClick={() => navigate("/annotate")}
            className="inline-flex items-center gap-4 bg-primary text-white px-12 py-5 rounded-2xl font-black uppercase tracking-[0.2em] text-sm hover:bg-primary/90 transition-all hover:gap-6 shadow-2xl shadow-primary/30 group"
          >
            Start Session <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
          </button>
          <p className="text-slate-400 mt-6 text-[10px] font-black uppercase tracking-[0.3em]">
            Time estimate: 8-10 minutes
          </p>
        </div>
      </div>
    </div>
  );
}
