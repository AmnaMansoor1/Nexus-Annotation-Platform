import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Loader2 } from "lucide-react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase";
import { getDoc, doc } from "firebase/firestore";

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

      // 2. Load admin config to check allowed emails
      let allowedAdminEmails = ["admin@gmail.com"];
      try {
        const configDoc = await getDoc(doc(db, "admin_config", "settings"));
        if (configDoc.exists()) {
          allowedAdminEmails = configDoc.data().admin_emails || ["admin@gmail.com"];
        }
      } catch (configErr) {
        console.warn("Could not load admin config, using default admin email", configErr);
      }
      
      // 3. Authorization check
      if (allowedAdminEmails.includes(email.toLowerCase())) {
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
    <div className="min-h-screen flex items-center justify-center bg-white px-4 relative overflow-hidden">
      <div className="max-w-md w-full relative">
        <div className="bg-white rounded-3xl shadow-lg border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-500">
          {/* Header */}
          <div className="bg-white pt-12 px-10 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gray-100 text-gray-700 mb-4">
              <Lock size={32} />
            </div>
            <h1 className="text-4xl font-black tracking-tighter text-gray-800 italic">ADMIN PORTAL</h1>
            <p className="text-gray-500 mt-2 text-base">
              Sign in to continue
            </p>
          </div>

          <div className="px-10 pt-8 pb-12">
            <form onSubmit={handleLogin} className="space-y-6">
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

              {error && (
                <div className="p-4 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100 animate-in shake duration-300">
                  {error}
                </div>
              )}

              <div className="flex justify-between items-center mt-4">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="text-blue-600 text-sm font-medium hover:underline focus:outline-none"
                >
                  Go to Student View
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-8 py-3 bg-blue-600 text-white rounded-full font-medium text-sm shadow-md hover:bg-blue-700 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <span>Next</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
