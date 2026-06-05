import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Loader2 } from "lucide-react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Proactive redirection if already logged in
  useEffect(() => {
    const sessionStr = localStorage.getItem("nexus_user_session");
    if (sessionStr) {
      const session = JSON.parse(sessionStr);
      if (session.role === "admin") navigate("/admin/dashboard");
      else navigate("/");
    }
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // 1. Authenticate with Firebase (Server-side check)
      await signInWithEmailAndPassword(auth, email, password);

      // 2. Authorization check (Only the master admin email allowed)
      if (email.toLowerCase() === "admin@gmail.com") {
        const session = {
          email: email.toLowerCase(),
          role: "admin",
          lastActive: new Date().toISOString(),
          loggedInAt: new Date().toISOString()
        };
        localStorage.setItem("nexus_user_session", JSON.stringify(session));
        window.dispatchEvent(new Event("nexus-session-changed"));
        navigate("/admin/dashboard");
      } else {
        await auth.signOut();
        throw new Error("Access Denied: You do not have administrator privileges.");
      }
    } catch (err: any) {
      console.error("Admin Login Error:", err);
      let message = "Invalid admin credentials.";
      if (err.code === "auth/invalid-credential" || err.code === "auth/user-not-found" || err.code === "auth/wrong-password") {
        message = "Incorrect email or access key.";
      } else {
        message = err.message || "An unexpected security error occurred.";
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4 relative overflow-hidden">
      {/* Abstract background shapes */}
      <div className="absolute top-0 right-0 w-1/2 h-full bg-primary/5 -skew-x-12 translate-x-1/4" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/2 bg-primary/10 rounded-full blur-[120px]" />

      <div className="max-w-md w-full bg-white p-12 rounded-[40px] border border-slate-200 shadow-2xl relative animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-slate-900 text-white mb-6 rotate-3 hover:rotate-0 transition-transform duration-500 shadow-xl shadow-slate-900/20">
            <Lock size={36} />
          </div>
          <h1 className="text-4xl font-black text-slate-900 tracking-tighter italic">ADMIN PORTAL</h1>
          <p className="text-slate-400 mt-3 text-[10px] uppercase tracking-[0.3em] font-black">
            Nexus Security Layer
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Secure Email</label>
            <input
              type="email"
              required
              className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:bg-white focus:border-slate-900/10 focus:ring-4 focus:ring-slate-900/5 outline-none transition-all font-bold text-slate-700 placeholder:text-slate-300"
              placeholder="admin@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Access Key</label>
            <input
              type="password"
              required
              className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:bg-white focus:border-slate-900/10 focus:ring-4 focus:ring-slate-900/5 outline-none transition-all font-bold text-slate-700 placeholder:text-slate-300"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="p-5 rounded-2xl bg-red-50 text-red-600 text-sm font-bold border-2 border-red-100 animate-in shake duration-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black uppercase tracking-[0.2em] text-xs hover:bg-black transition-all shadow-xl shadow-slate-900/20 active:scale-[0.98] mt-4 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : "Authenticate & Access"}
          </button>
          
          <div className="pt-8 text-center">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="text-[10px] text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center gap-3 mx-auto font-black uppercase tracking-[0.2em] group"
            >
              <span className="group-hover:-translate-x-1 transition-transform">←</span> Return to Student View
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
