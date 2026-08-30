import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase.js";
import { Dashboard } from "./pages/Dashboard.js";
import { InventoryPage } from "./pages/InventoryPage.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { HybridPage } from "./pages/HybridPage.js";
import { DraftEditorPage } from "./pages/DraftEditorPage.js";
import { DraftsPage } from "./pages/DraftsPage.js";
import { NewDraftPage } from "./pages/NewDraftPage.js";

function LegacyInventoryDraftRedirect() {
  const { draftId } = useParams();
  if (!draftId) return <Navigate to="/drafts" replace />;
  return <Navigate to={`/drafts/${draftId}`} replace />;
}

const NAV_ITEMS = [
  { to: "/", label: "Dashboard" },
  { to: "/inventory", label: "Inventory" },
  { to: "/drafts", label: "Listing drafts" },
  { to: "/integrations", label: "Integrations" },
  { to: "/hybrid", label: "Poshmark / Mercari" },
];

function isActivePath(navTo: string, pathname: string): boolean {
  if (navTo === "/") return pathname === "/";
  return pathname === navTo || pathname.startsWith(`${navTo}/`);
}

function AppBar({ email }: { email: string | null }) {
  const { pathname } = useLocation();
  const initial = email?.trim()?.[0]?.toUpperCase() ?? "?";
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <div style={{ display: "flex", alignItems: "center", gap: 28, minWidth: 0 }}>
          <Link to="/" className="brand">
            <span className="brand-mark">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </span>
            Crosslister
          </Link>
          <nav className="appnav">
            {NAV_ITEMS.map((item) => (
              <Link key={item.to} to={item.to} className={`navlink${isActivePath(item.to, pathname) ? " active" : ""}`}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none" }}>
          {email && <span style={{ fontSize: 13, color: "#64748b" }}>{email}</span>}
          <button
            type="button"
            className="appbtn"
            style={{ padding: "6px 12px", fontSize: 13 }}
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
          <span className="avatar">{initial}</span>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) {
    return <div className="layout">Loading…</div>;
  }

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <AppBar email={session.user?.email ?? null} />
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/drafts" element={<DraftsPage />} />
          <Route path="/drafts/new" element={<NewDraftPage />} />
          <Route path="/drafts/:draftId" element={<DraftEditorPage />} />
          <Route path="/inventory/drafts/:draftId" element={<LegacyInventoryDraftRedirect />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/hybrid" element={<HybridPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
