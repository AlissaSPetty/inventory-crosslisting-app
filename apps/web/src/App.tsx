import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
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
    <div className="layout">
      <nav>
        <Link to="/">Dashboard</Link>
        <Link to="/inventory">Inventory</Link>
        <Link to="/drafts">Listing drafts</Link>
        <Link to="/integrations">Integrations</Link>
        <Link to="/hybrid">Poshmark / Mercari</Link>
        <button type="button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>
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
    </div>
  );
}
