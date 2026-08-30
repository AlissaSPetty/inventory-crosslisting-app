import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";

type Device = {
  id: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type PoshmarkConnection =
  | { platform: string; shop_domain: string | null; updated_at?: string }
  | undefined;

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/**
 * Poshmark connection via the browser extension. Poshmark has no API, so the
 * extension reads the user's closet in their own session and pushes it here.
 * This card mints a one-time pairing code, shows connection status, and lists /
 * revokes paired devices.
 */
export function PoshmarkExtensionCard({
  connection,
  onConnectionChange,
}: {
  connection: PoshmarkConnection;
  onConnectionChange: () => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const devicesQuery = useQuery({
    queryKey: ["extension", "devices"],
    queryFn: () => apiFetch("/api/extension/devices") as Promise<{ devices: Device[] }>,
  });

  const genCode = useMutation({
    mutationFn: () =>
      apiFetch("/api/integrations/poshmark/pairing-code", { method: "POST" }) as Promise<{
        code: string;
        expiresAt: string;
      }>,
    onSuccess: (d) => {
      setCode(d.code);
      setCodeExpiresAt(d.expiresAt);
      setCopied(false);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/extension/devices/${id}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["extension", "devices"] }),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      apiFetch("/api/integrations/poshmark", { method: "DELETE" }) as Promise<{ ok: boolean }>,
    onSuccess: () => {
      setConfirmDisconnect(false);
      onConnectionChange();
    },
  });

  const devices = (devicesQuery.data?.devices ?? []).filter((d) => !d.revoked_at);
  const username = connection?.shop_domain ?? null;

  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem" }}>Poshmark</h2>
      <p style={{ marginTop: 0, color: "#64748b", fontSize: "0.9rem" }}>
        Connected through the browser extension — Poshmark has no API, so the extension reads your
        closet in your own logged-in session and syncs it here for tracking.
      </p>

      {connection ? (
        <p
          role="status"
          style={{
            padding: "0.5rem 0.75rem",
            margin: "0.5rem 0 0.75rem",
            borderRadius: 6,
            background: "#ecfdf5",
            border: "1px solid #6ee7b7",
            color: "#065f46",
            fontSize: "0.92rem",
          }}
        >
          Connected{username ? ` as ${username}` : ""}
          {connection.updated_at ? ` · last sync ${formatWhen(connection.updated_at)}` : ""}
        </p>
      ) : (
        <p style={{ color: "#64748b", fontSize: "0.9rem" }}>
          Not connected yet. Install the extension, then pair it with a code below.
        </p>
      )}

      {/* Pairing */}
      <div style={{ marginTop: "0.5rem" }}>
        <ol style={{ margin: "0 0 0.75rem", paddingLeft: "1.2rem", color: "#475569", fontSize: "0.9rem", lineHeight: 1.6 }}>
          <li>Install the Inventory browser extension and make sure you're logged into Poshmark.</li>
          <li>Generate a pairing code here, then paste it into the extension popup.</li>
          <li>The extension reads your closet and keeps quantity in sync.</li>
        </ol>
        <button className="primary" type="button" disabled={genCode.isPending} onClick={() => genCode.mutate()}>
          {genCode.isPending ? "Generating…" : "Generate pairing code"}
        </button>
        {genCode.isError && (
          <p className="error" style={{ marginTop: "0.5rem" }}>
            {(genCode.error as Error).message}
          </p>
        )}
        {code && (
          <div
            style={{
              marginTop: "0.75rem",
              padding: "0.75rem 1rem",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              maxWidth: 420,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
              <code style={{ fontSize: "1.15rem", letterSpacing: "0.05em", fontWeight: 600 }}>{code}</code>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(code).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    },
                    () => setCopied(false)
                  )
                }
                style={{ fontSize: "0.85rem" }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: "#64748b" }}>
              Paste into the extension within 10 minutes{codeExpiresAt ? ` (expires ${formatWhen(codeExpiresAt)})` : ""}.
              Single use.
            </p>
          </div>
        )}
      </div>

      {/* Paired devices */}
      <div style={{ marginTop: "1rem" }}>
        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>Paired devices</h3>
        {devicesQuery.isLoading && <p style={{ color: "#64748b", fontSize: "0.9rem" }}>Loading…</p>}
        {!devicesQuery.isLoading && devices.length === 0 && (
          <p style={{ color: "#64748b", fontSize: "0.9rem", margin: 0 }}>No devices paired yet.</p>
        )}
        {devices.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.4rem" }}>
            {devices.map((d) => (
              <li
                key={d.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.88rem",
                }}
              >
                <span>
                  <strong>{d.label?.trim() || "Extension"}</strong>
                  <span style={{ color: "#64748b" }}>
                    {" · paired "}
                    {formatWhen(d.created_at)}
                    {d.last_used_at ? ` · last used ${formatWhen(d.last_used_at)}` : " · never used"}
                  </span>
                </span>
                <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>
                  {revoke.isPending ? "…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && (
          <p className="error" style={{ marginTop: "0.5rem" }}>
            {(revoke.error as Error).message}
          </p>
        )}
      </div>

      {connection && (
        <div style={{ marginTop: "1rem" }}>
          {confirmDisconnect ? (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.9rem", color: "#475569" }}>
                Stop tracking Poshmark? Paired devices stay paired (revoke them above separately).
              </span>
              <button
                type="button"
                className="primary"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button type="button" disabled={disconnect.isPending} onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDisconnect(true)}>
              Disconnect Poshmark
            </button>
          )}
          {disconnect.isError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {(disconnect.error as Error).message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
