import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState, Component, ReactNode, lazy, Suspense } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";

// Student Components (Lazy Loaded)
const Login = lazy(() => import("./student/Login"));
const Welcome = lazy(() => import("./student/Welcome"));
const AnnotationWorkbench = lazy(() => import("./student/AnnotationWorkbench"));
const Completion = lazy(() => import("./student/Completion"));

// Admin Components (Regular Import for main entry, Lazy for others)
import AdminLogin from "./admin/AdminLogin";
const AdminLayout = lazy(() => import("./admin/AdminLayout"));
const Dashboard = lazy(() => import("./admin/Dashboard"));
const ArticlesTable = lazy(() => import("./admin/ArticlesTable"));
const AnnotatorsTable = lazy(() => import("./admin/AnnotatorsTable"));
const UploadCSV = lazy(() => import("./admin/UploadCSV"));
const ExportCSV = lazy(() => import("./admin/ExportCSV"));
const Settings = lazy(() => import("./admin/Settings"));

// Loading Component for Suspense
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center bg-bg-student">
    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
  </div>
);

// Simple Error Boundary
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{children: ReactNode}, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: any) { console.error("App Crash:", error, info); }
  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-red-50 p-6">
          <div className="text-center max-w-md">
            <h1 className="text-2xl font-bold text-red-600">Something went wrong.</h1>
            <p className="text-red-500 mt-2 text-sm font-mono bg-white p-4 rounded-xl border border-red-100 break-words">
              {this.state.error.message}
            </p>
            <button onClick={() => { localStorage.removeItem("nexus_user_session"); window.location.href = "/"; }} className="mt-6 px-6 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-200 active:scale-95 transition-all">
              Reset Session & Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function readStoredSession() {
  const sessionStr = localStorage.getItem("nexus_user_session");
  if (!sessionStr) return null;

  const parsed = JSON.parse(sessionStr);
  if (!parsed?.lastActive) return null;

  const lastActive = new Date(parsed.lastActive).getTime();
  const now = new Date().getTime();
  if (now - lastActive > 24 * 60 * 60 * 1000) {
    localStorage.removeItem("nexus_user_session");
    return null;
  }

  return parsed;
}

function App() {
  const [session, setSession] = useState<{ email: string; role: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Sync with Firebase Auth (Source of truth)
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        // User is logged in via Firebase
        const stored = readStoredSession();
        // Ensure stored session matches current Firebase user
        if (stored && stored.email.toLowerCase() === user.email?.toLowerCase()) {
          setSession(stored);
        } else {
          // If mismatch, assume role from email (or fetch from Firestore in production)
          const role = user.email === "admin@gmail.com" ? "admin" : "annotator";
          const newSession = { email: user.email!, role };
          localStorage.setItem("nexus_user_session", JSON.stringify({ ...newSession, lastActive: new Date().toISOString() }));
          setSession(newSession);
        }
      } else {
        // User is logged out via Firebase
        localStorage.removeItem("nexus_user_session");
        setSession(null);
      }
      setLoading(false);
    });

    // 2. Event listeners for tab synchronization
    const syncSession = () => {
      setSession(readStoredSession());
    };

    window.addEventListener("storage", syncSession);
    window.addEventListener("nexus-session-changed", syncSession);

    return () => {
      unsubscribeAuth();
      window.removeEventListener("storage", syncSession);
      window.removeEventListener("nexus-session-changed", syncSession);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-student">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  const isStudent = !!(session && session.role === "annotator");
  const isAdmin = !!(session && session.role === "admin");

  return (
    <ErrorBoundary>
      <Router>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Student Routes */}
            <Route 
              path="/" 
              element={
                session?.role === "annotator" ? <Navigate to="/annotate" /> : <Login />
              } 
            />
            <Route path="/welcome" element={isStudent ? <Welcome /> : <Navigate to="/" />} />
            <Route path="/annotate" element={isStudent ? <AnnotationWorkbench /> : <Navigate to="/" />} />
            <Route path="/done" element={isStudent ? <Completion /> : <Navigate to="/" />} />

            {/* Admin Routes */}
            <Route path="/admin" element={isAdmin ? <Navigate to="/admin/dashboard" /> : <AdminLogin />} />
            <Route path="/admin/dashboard" element={isAdmin ? <AdminLayout><Dashboard /></AdminLayout> : <Navigate to="/admin" />} />
            <Route path="/admin/articles" element={isAdmin ? <AdminLayout><ArticlesTable /></AdminLayout> : <Navigate to="/admin" />} />
            <Route path="/admin/annotators" element={isAdmin ? <AdminLayout><AnnotatorsTable /></AdminLayout> : <Navigate to="/admin" />} />
            <Route path="/admin/upload" element={isAdmin ? <AdminLayout><UploadCSV /></AdminLayout> : <Navigate to="/admin" />} />
            <Route path="/admin/export" element={isAdmin ? <AdminLayout><ExportCSV /></AdminLayout> : <Navigate to="/admin" />} />
            <Route path="/admin/settings" element={isAdmin ? <AdminLayout><Settings /></AdminLayout> : <Navigate to="/admin" />} />
          </Routes>
        </Suspense>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
