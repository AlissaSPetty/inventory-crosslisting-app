import { useEffect, useState } from "react";
import { browser } from "#imports";
import type { PairResponse, StatusResponse, SyncResponse } from "@/utils/messages";

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const s = (await browser.runtime.sendMessage({ type: "GET_STATUS" })) as StatusResponse;
    setStatus(s);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const pair = async () => {
    setBusy(true);
    setMsg(null);
    const r = (await browser.runtime.sendMessage({ type: "PAIR", code: code.trim() })) as PairResponse;
    setBusy(false);
    if (r.ok) {
      setCode("");
      setMsg("Paired! You can sync your closet now.");
      void refresh();
    } else {
      setMsg(r.error ?? "Pairing failed");
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setMsg(null);
    const tabs = await browser.tabs.query({ url: "*://*.poshmark.com/*" });
    const tabId = tabs[0]?.id;
    if (tabId == null) {
      setBusy(false);
      setMsg("Open Poshmark in a tab first, then Sync.");
      return;
    }
    try {
      const r = (await browser.tabs.sendMessage(tabId, { type: "SYNC_POSHMARK" })) as SyncResponse;
      setMsg(
        r.ok
          ? `Synced ${r.imported ?? 0} listing(s)${r.pruned ? `, removed ${r.pruned}` : ""}.`
          : r.error ?? "Sync failed"
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const paired = status?.paired;

  return (
    <div style={{ width: 320, padding: 16, fontFamily: "system-ui, sans-serif", color: "#0f172a" }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Inventory · Poshmark</h3>

      {paired ? (
        <>
          <p style={{ fontSize: 13, color: "#065f46", margin: "0 0 10px" }}>
            Connected{status?.poshmark?.username ? ` as ${status.poshmark.username}` : ""}.
          </p>
          <button onClick={syncNow} disabled={busy} style={btn}>
            {busy ? "Working…" : "Sync now"}
          </button>
          <p style={{ fontSize: 11, color: "#64748b", marginTop: 10 }}>
            Open your Poshmark closet page for the most complete sync.
          </p>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "#475569", margin: "0 0 8px" }}>
            Paste the pairing code from the app's Integrations page.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-…"
            style={{ width: "100%", padding: 8, marginBottom: 8, boxSizing: "border-box" }}
          />
          <button onClick={pair} disabled={busy || !code.trim()} style={btn}>
            {busy ? "Pairing…" : "Pair"}
          </button>
        </>
      )}

      {msg && <p style={{ fontSize: 12, marginTop: 12 }}>{msg}</p>}
    </div>
  );
}

const btn: React.CSSProperties = {
  width: "100%",
  padding: 8,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#f8fafc",
  cursor: "pointer",
};
