import { useEffect, useState, ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { auth } from "../firebase";
import { 
  LayoutDashboard, 
  Users, 
  Upload, 
  Download, 
  Settings as SettingsIcon,
  LogOut,
  Menu,
  LogIn
} from "lucide-react";

interface AdminLayoutProps {
  children: ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    try {
      const sessionStr = localStorage.getItem("nexus_user_session");
      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        if (session.role !== "admin") {
          navigate("/admin");
        }
      } else {
        navigate("/admin");
      }
    } catch (err) {
      console.error("AdminLayout session error:", err);
      navigate("/admin");
    }
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await auth.signOut();
      localStorage.removeItem("nexus_user_session");
      window.dispatchEvent(new Event("nexus-session-changed"));
      navigate("/admin");
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  const navItems = [
    { to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/admin/annotators", label: "Annotators", icon: Users },
    { to: "/admin/upload", label: "Upload CSV", icon: Upload },
    { to: "/admin/export", label: "Export", icon: Download },
    { to: "/admin/settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] flex overflow-hidden font-sans">
      {/* Sidebar - Desktop */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-100 transform transition-transform duration-300 ease-in-out md:translate-x-0 md:static shadow-xl shadow-slate-200/20
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        <div className="flex flex-col h-full">
          <div className="p-8 border-b border-slate-50 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
            <h1 className="text-2xl font-black tracking-tighter flex items-center gap-3 text-primary italic">
              NEXUS
              <span className="text-[10px] not-italic font-black bg-slate-100 text-slate-400 px-2 py-1 rounded-md uppercase tracking-widest">Admin</span>
            </h1>
          </div>

          <nav className="flex-1 p-6 space-y-2 overflow-y-auto admin-scrollbar">
            <div className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em] mb-4 ml-4">Main Menu</div>
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `
                  flex items-center gap-4 px-5 py-4 rounded-2xl transition-all font-bold text-sm
                  ${isActive ? "bg-primary text-white shadow-lg shadow-primary/20 scale-[1.02]" : "text-slate-400 hover:text-primary hover:bg-slate-50"}
                `}
                onClick={() => setSidebarOpen(false)}
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={20} className={isActive ? "text-white" : ""} />
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="p-6 space-y-2">
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-4 w-full px-5 py-4 rounded-2xl text-slate-400 hover:text-primary hover:bg-slate-50 transition-all font-bold text-sm"
            >
              <LogIn size={20} />
              Student Portal
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-4 w-full px-5 py-4 rounded-2xl text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all font-bold text-sm"
            >
              <LogOut size={20} />
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header - Mobile */}
        <header className="md:hidden bg-white border-b border-slate-200 p-4 flex items-center justify-between sticky top-0 z-30">
          <button onClick={() => setSidebarOpen(true)} className="p-2 hover:bg-slate-50 rounded-xl text-slate-600 transition-colors border border-slate-100 shadow-sm">
            <Menu size={20} />
          </button>
          <span className="font-black text-primary tracking-tighter text-xl">NEXUS</span>
          <div className="w-10" /> {/* Spacer */}
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>

      {/* Overlay - Mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 z-40 md:hidden backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}
