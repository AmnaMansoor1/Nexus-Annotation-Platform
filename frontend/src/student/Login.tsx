import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { db, auth } from "../firebase";
import { Annotator } from "../types";
import { updatePlatformStats } from "../utils/stats";
import { UserPlus, LogIn, Mail, User, Loader2, Lock } from "lucide-react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // To satisfy "Email Only" login while still having a "Properly Authenticated" session for Firestore rules,
      // we use a deterministic password for student accounts.
      // We trim and lowercase the email to ensure consistency.
      const cleanEmail = email.toLowerCase().trim();
      const studentAuthPassword = `nexus_${cleanEmail.replace(/[^a-z0-9]/g, '')}_2026`;

      if (mode === "signup") {
        if (!fullName) throw new Error("Full name is required.");
        if (password.length < 6) throw new Error("Password must be at least 6 characters.");
        
        // 1. Create Auth User using our deterministic password
        const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, studentAuthPassword);
        const user = userCredential.user;

        // 2. Create Firestore Profile (We store the "Registration Code" they typed)
        const newUser: Annotator = {
          email: cleanEmail,
          full_name: fullName,
          registration_code: password, // Store the password they typed as a registration code
          completed: false,
          completed_articles: [],
          assigned_articles: [],
          reliability_score: 0,
          gold_total_count: 0,
          gold_correct_count: 0,
          gold_accuracy: 0
        };

        await setDoc(doc(db, "annotators", cleanEmail), newUser);
        await updatePlatformStats({ totalAnnotators: 1 });
        
        navigate("/welcome");
      } else {
        // 1. Try to Authenticate using the deterministic password
        try {
          await signInWithEmailAndPassword(auth, cleanEmail, studentAuthPassword);
        } catch (authErr: any) {
          // If the user exists in Firestore but NOT in Firebase Auth (legacy user)
          // We attempt to "auto-repair" by creating their Auth account.
          if (authErr.code === "auth/invalid-credential" || authErr.code === "auth/user-not-found") {
            try {
              // Check if they exist in Firestore first
              const snap = await getDoc(doc(db, "annotators", cleanEmail));
              if (snap.exists()) {
                await createUserWithEmailAndPassword(auth, cleanEmail, studentAuthPassword);
              } else {
                throw new Error("Account not found. Please sign up first.");
              }
            } catch (createErr: any) {
              if (createErr.code === "auth/email-already-in-use") {
                throw new Error("This email is registered with a different password. Please contact Admin to reset your account.");
              }
              throw createErr;
            }
          } else {
            throw authErr;
          }
        }
        
        // 2. Final check for Firestore profile
        const snap = await getDoc(doc(db, "annotators", cleanEmail));
        if (!snap.exists()) {
          throw new Error("Profile data not found. Please contact admin.");
        }

        if (cleanEmail === "admin@gmail.com") navigate("/admin/dashboard");
        else navigate("/welcome");
      }
    } catch (err: any) {
      console.error("Auth Error:", err);
      let message = "Authentication failed.";
      if (err.code === "auth/email-already-in-use") message = "This email is already registered.";
      else if (err.code === "auth/invalid-credential") message = "Incorrect email or password.";
      else if (err.code === "auth/weak-password") message = "Password is too weak.";
      else message = err.message || "An unexpected error occurred.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-student px-4 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
      
      <div className="max-w-md w-full relative">
        <div className="bg-white rounded-[40px] shadow-2xl shadow-slate-200/50 border border-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-500">
          {/* Header */}
          <div className="bg-white p-10 text-center border-b border-slate-50 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-primary" />
            <h1 className="text-5xl font-black tracking-tighter text-primary italic">NEXUS</h1>
            <p className="text-slate-400 mt-3 text-xs uppercase tracking-[0.2em] font-black">
              Annotation Platform
            </p>
          </div>

          {/* Tab Switcher */}
          <div className="flex bg-slate-50/80 p-1.5 mx-8 my-6 rounded-2xl border border-slate-100">
            <button
              onClick={() => setMode("login")}
              className={`flex-1 py-3 text-sm font-black uppercase tracking-wider flex items-center justify-center gap-2 rounded-xl transition-all ${
                mode === "login" ? "text-primary bg-white shadow-md shadow-slate-200" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <LogIn size={18} /> Login
            </button>
            <button
              onClick={() => setMode("signup")}
              className={`flex-1 py-3 text-sm font-black uppercase tracking-wider flex items-center justify-center gap-2 rounded-xl transition-all ${
                mode === "signup" ? "text-primary bg-white shadow-md shadow-slate-200" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <UserPlus size={18} /> Sign Up
            </button>
          </div>

          <div className="px-10 pb-10">
            <form onSubmit={handleAuth} className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 block">Institutional Email</label>
                <div className="relative group">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-primary transition-colors" size={20} />
                  <input
                    type="email"
                    required
                    className="w-full pl-12 pr-6 py-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:bg-white focus:border-primary/20 focus:ring-4 focus:ring-primary/5 outline-none transition-all font-bold text-slate-700 placeholder:text-slate-300 placeholder:font-medium"
                    placeholder="student@university.edu"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              {mode === "signup" && (
                <div className="space-y-4 animate-in slide-in-from-top-4 duration-300">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 block">Registration Code / Password</label>
                    <div className="relative group">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-primary transition-colors" size={20} />
                      <input
                        type="password"
                        required
                        className="w-full pl-12 pr-6 py-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:bg-white focus:border-primary/20 focus:ring-4 focus:ring-primary/5 outline-none transition-all font-bold text-slate-700 placeholder:text-slate-300 placeholder:font-medium"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 block">Full Name</label>
                    <div className="relative group">
                      <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-primary transition-colors" size={20} />
                      <input
                        type="text"
                        required
                        className="w-full pl-12 pr-6 py-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:bg-white focus:border-primary/20 focus:ring-4 focus:ring-primary/5 outline-none transition-all font-bold text-slate-700 placeholder:text-slate-300 placeholder:font-medium"
                        placeholder="John Doe"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-5 rounded-2xl bg-red-50 text-red-600 text-sm font-bold border-2 border-red-100 flex items-start gap-3 animate-in shake duration-300">
                  <div className="w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5">!</div>
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase tracking-[0.2em] shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 mt-4"
              >
                {loading ? (
                  <Loader2 className="animate-spin" size={20} />
                ) : (
                  <>
                    {mode === "login" ? "Enter Portal" : "Create Account"}
                    <LogIn size={20} className={mode === "signup" ? "hidden" : ""} />
                  </>
                )}
              </button>
            </form>
            
            <div className="pt-8 text-center space-y-4">
              <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
                Research Project • University Level
              </p>
              <Link 
                to="/admin" 
                className="inline-block text-[10px] font-black text-slate-400 hover:text-primary uppercase tracking-[0.2em] transition-colors border-t border-slate-50 pt-4 w-full"
              >
                Access Admin Portal →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
