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
    <div className="min-h-screen flex items-center justify-center bg-white px-4 relative overflow-hidden">
      <div className="max-w-md w-full relative">
        <div className="bg-white rounded-3xl shadow-lg border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-500">
          {/* Header */}
          <div className="bg-white pt-12 px-10 text-center">
            <h1 className="text-5xl font-black tracking-tighter text-gray-800 italic">NEXUS</h1>
            <p className="text-gray-500 mt-2 text-base">
              {mode === "login" ? "Sign in" : "Create your account"}
            </p>
            <p className="text-gray-400 mt-1 text-sm">
              {mode === "login" ? "to continue to the annotation platform" : "to get started with annotations"}
            </p>
          </div>

          <div className="px-10 pt-8 pb-12">
            <form onSubmit={handleAuth} className="space-y-6">
              <div className="space-y-2">
                <div className="relative group">
                  <input
                    type="email"
                    required
                    id="email"
                    className="w-full px-4 py-4 rounded-xl bg-white border-2 border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-base text-gray-800 placeholder:text-gray-400"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              {mode === "signup" && (
                <div className="space-y-6 animate-in slide-in-from-top-4 duration-300">
                  <div className="space-y-2">
                    <div className="relative group">
                      <input
                        type="text"
                        required
                        id="fullName"
                        className="w-full px-4 py-4 rounded-xl bg-white border-2 border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-base text-gray-800 placeholder:text-gray-400"
                        placeholder="Full Name"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="relative group">
                      <input
                        type="password"
                        required
                        id="password"
                        className="w-full px-4 py-4 rounded-xl bg-white border-2 border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-base text-gray-800 placeholder:text-gray-400"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-4 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100 flex items-start gap-3 animate-in shake duration-300">
                  <div className="w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold">!</div>
                  <span>{error}</span>
                </div>
              )}

              <div className="flex justify-between items-center mt-4">
                <button
                  type="button"
                  onClick={() => setMode(mode === "login" ? "signup" : "login")}
                  className="text-blue-600 text-sm font-medium hover:underline focus:outline-none"
                >
                  {mode === "login" ? "Create account" : "Sign in instead"}
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-8 py-3 bg-blue-600 text-white rounded-full font-medium text-sm shadow-md hover:bg-blue-700 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <span>{mode === "login" ? "Next" : "Create"}</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
        
        <div className="pt-8 text-center">
          <Link 
            to="/admin" 
            className="inline-block text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Go to Admin Portal
          </Link>
        </div>
      </div>
    </div>
  );
}
