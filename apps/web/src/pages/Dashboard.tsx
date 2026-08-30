import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";
import {
  ChannelMonogram,
  PLATFORM_META,
  PLATFORM_ORDER,
  STATUS_META,
  StatusPill,
  platformLabel,
  type StatusKey,
} from "../lib/listingsUi.js";

type Connection = { platform: string; shop_domain?: string | null };

type LiveRow = {
  id: string;
  platform: string;
  listed_at: string | null;
  listing_title: string | null;
  inventory_item_id: string | null;
  inventory_items: { title: string | null } | null;
};

type DraftRow = {
  id: string;
  platform: string;
  updated_at: string;
  payload: Record<string, unknown>;
  inventory_items: { title: string | null; draft_ai_status?: string | null } | null;
};

type SoldItem = { id: string; title: string | null; sold_at: string | null };

function isDraftProcessing(d: DraftRow): boolean {
  return d.inventory_items?.draft_ai_status === "pending" || d.payload?._generationPending === true;
}

function isDraftFailed(d: DraftRow): boolean {
  return d.inventory_items?.draft_ai_status === "failed" || d.payload?._generationFailed === true;
}

/** Friendly account handle from a connection's `shop_domain` (eBay stores JSON). */
function connectionHandle(platform: string, shop_domain?: string | null): string | null {
  if (!shop_domain) return null;
  if (platform === "ebay" && shop_domain.startsWith("{")) {
    try {
      const p = JSON.parse(shop_domain) as { username?: string; userId?: string };
      return p.username?.trim() || p.userId || null;
    } catch {
      return shop_domain;
    }
  }
  return shop_domain;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function Chevron() {
  return (
    <div style={{ display: "flex", alignItems: "center", color: "#cbd5e1", flex: "none" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </div>
  );
}

function PipelineTile({
  status,
  count,
  sub,
  accent,
}: {
  status: StatusKey;
  count: number;
  sub: string;
  accent: string;
}) {
  const m = STATUS_META[status];
  return (
    <div className="tile" style={{ flex: "1 1 180px", borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: m.fg }}>
        {status === "inprogress" ? (
          <span className="status-spinner" aria-hidden />
        ) : (
          <span className="status-dot" style={{ background: m.dot }} aria-hidden />
        )}
        <span className="kicker">{m.label}</span>
      </div>
      <div className="statnum" style={{ marginTop: 12, color: "#0f172a" }}>
        {count}
      </div>
      <div style={{ marginTop: 3, fontSize: 13, color: "#64748b" }}>{sub}</div>
    </div>
  );
}

export function Dashboard() {
  const qc = useQueryClient();

  const { data: integ } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => apiFetch("/api/integrations") as Promise<{ connections: Connection[] }>,
  });

  const { data: liveData } = useQuery({
    queryKey: ["platform-listings", "live"],
    queryFn: () => apiFetch("/api/platform-listings?status=live") as Promise<{ listings: LiveRow[] }>,
  });

  const { data: draftData } = useQuery({
    queryKey: ["listing-drafts", "unpublished"],
    queryFn: () =>
      apiFetch("/api/listing-drafts?unpublished_only=true") as Promise<{ drafts: DraftRow[] }>,
    refetchInterval: (query) => {
      const list = (query.state.data as { drafts?: DraftRow[] } | undefined)?.drafts;
      return list?.some(isDraftProcessing) ? 2500 : false;
    },
  });

  const { data: soldData } = useQuery({
    queryKey: ["inventory", "sold"],
    queryFn: () => apiFetch("/api/inventory?status=sold") as Promise<{ items: SoldItem[] }>,
  });

  const refreshAll = useMutation({
    mutationFn: () =>
      apiFetch("/api/sync/all", { method: "POST", body: JSON.stringify({}) }) as Promise<unknown>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-listings", "live"] });
      qc.invalidateQueries({ queryKey: ["inventory", "sold"] });
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });

  const connections = integ?.connections ?? [];
  const connected = new Set(connections.map((c) => c.platform));
  const live = (liveData?.listings ?? []).filter((l) => connected.has(l.platform));
  const drafts = (draftData?.drafts ?? []).filter((d) => connected.has(d.platform));
  const sold = soldData?.items ?? [];

  const processing = drafts.filter(isDraftProcessing);
  const failed = drafts.filter(isDraftFailed);
  const ready = drafts.filter((d) => !isDraftProcessing(d) && !isDraftFailed(d));
  const readyChannels = new Set(ready.map((d) => d.platform)).size;
  const sold30 = sold.filter((s) => {
    const t = s.sold_at ? Date.parse(s.sold_at) : NaN;
    return !Number.isNaN(t) && Date.now() - t <= 30 * DAY_MS;
  });

  const liveByPlatform = (p: string) => live.filter((l) => l.platform === p).length;
  const draftsByPlatform = (p: string) => drafts.filter((d) => d.platform === p).length;

  const failedNames = failed
    .map((d) => inventoryItemDisplayName(d.inventory_items?.title, undefined))
    .filter((n) => n && n !== "—");

  // Recent activity, composed from real sold items, newly-live listings and failed drafts.
  type Activity = { key: string; kind: StatusKey; verb: string; title: string; meta: string; time: number };
  const activity: Activity[] = [];
  for (const s of sold) {
    const t = s.sold_at ? Date.parse(s.sold_at) : NaN;
    if (!Number.isNaN(t)) {
      activity.push({
        key: `sold-${s.id}`,
        kind: "sold",
        verb: "Sold",
        title: inventoryItemDisplayName(s.title, undefined),
        meta: timeAgo(s.sold_at),
        time: t,
      });
    }
  }
  for (const l of live) {
    const t = l.listed_at ? Date.parse(l.listed_at) : NaN;
    if (!Number.isNaN(t)) {
      activity.push({
        key: `live-${l.id}`,
        kind: "live",
        verb: "Listed",
        title: inventoryItemDisplayName(l.inventory_items?.title, l.listing_title?.trim() || undefined),
        meta: `${platformLabel(l.platform)} · ${timeAgo(l.listed_at)}`,
        time: t,
      });
    }
  }
  for (const d of failed) {
    const t = Date.parse(d.updated_at);
    if (!Number.isNaN(t)) {
      activity.push({
        key: `failed-${d.id}`,
        kind: "failed",
        verb: "Draft failed",
        title: inventoryItemDisplayName(d.inventory_items?.title, undefined),
        meta: `${platformLabel(d.platform)} · ${timeAgo(d.updated_at)}`,
        time: t,
      });
    }
  }
  activity.sort((a, b) => b.time - a.time);
  const recentActivity = activity.slice(0, 6);

  const connectedCount = PLATFORM_ORDER.filter((p) => connected.has(p)).length;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 22, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em" }}>Overview</h1>
          <p style={{ margin: "5px 0 0", fontSize: 14, color: "#64748b" }}>
            What&#39;s happening across your channels right now.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {refreshAll.isError && (
            <span className="error" style={{ fontSize: 13 }}>
              {(refreshAll.error as Error).message}
            </span>
          )}
          <button
            type="button"
            className="appbtn primary"
            disabled={connected.size === 0 || refreshAll.isPending}
            onClick={() => refreshAll.mutate()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {refreshAll.isPending ? "Refreshing…" : "Refresh all channels"}
          </button>
        </div>
      </div>

      {connected.size === 0 ? (
        <div className="tile" style={{ padding: "22px 24px" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Connect a channel to get started</h2>
          <p style={{ margin: "8px 0 0", fontSize: 14, color: "#64748b" }}>
            Link a marketplace under <Link to="/integrations">Integrations</Link> to see your pipeline,
            live listings, and sales here.
          </p>
        </div>
      ) : (
        <>
          {/* Pipeline */}
          <div className="kicker" style={{ color: "#94a3b8", margin: "0 0 10px 2px" }}>
            Listing pipeline
          </div>
          <div style={{ display: "flex", alignItems: "stretch", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <PipelineTile status="inprogress" count={processing.length} sub="AI writing drafts" accent={STATUS_META.inprogress.dot} />
            <Chevron />
            <PipelineTile
              status="ready"
              count={ready.length}
              sub={readyChannels ? `drafts across ${readyChannels} channel${readyChannels === 1 ? "" : "s"}` : "no drafts waiting"}
              accent={STATUS_META.ready.dot}
            />
            <Chevron />
            <PipelineTile status="live" count={live.length} sub="active on marketplaces" accent={STATUS_META.live.dot} />
            <Chevron />
            <PipelineTile status="sold" count={sold30.length} sub="sold in the last 30 days" accent={STATUS_META.sold.dot} />
          </div>

          {/* Attention */}
          {failed.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: "13px 18px", marginBottom: 24 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "#fee2e2", color: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#991b1b" }}>
                  {failed.length} draft{failed.length === 1 ? "" : "s"} failed to generate
                </div>
                {failedNames.length > 0 && (
                  <div style={{ fontSize: 13, color: "#991b1b", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {failedNames.slice(0, 2).map((n, i) => (
                      <span key={i}>
                        {i > 0 ? " and " : ""}
                        <span style={{ color: "#7f1d1d", fontWeight: 600 }}>{n}</span>
                      </span>
                    ))}
                    {failedNames.length > 2 ? ` and ${failedNames.length - 2} more` : ""}
                  </div>
                )}
              </div>
              <Link to="/drafts" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#dc2626", flex: "none" }}>
                Review &amp; retry
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
            </div>
          )}

          {/* Two column */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.45fr) minmax(0, 1fr)", gap: 20 }}>
            {/* Channels */}
            <div className="tile" style={{ padding: "4px 0 6px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 12px" }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Channels</h2>
                <Link to="/integrations" style={{ fontSize: 13, color: "#64748b" }}>
                  {connectedCount} connected
                </Link>
              </div>
              {PLATFORM_ORDER.map((p) => {
                const conn = connections.find((c) => c.platform === p);
                const meta = PLATFORM_META[p];
                if (!conn) {
                  return (
                    <div key={p} style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 20px", borderTop: "1px solid #f1f5f9" }}>
                      <span style={{ width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontWeight: 700, fontSize: 15, flex: "none", background: "#f1f5f9", border: "1px dashed #cbd5e1" }}>
                        {meta.letter}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8" }}>{meta.label}</div>
                        <div style={{ fontSize: 12.5, color: "#64748b" }}>Not connected</div>
                      </div>
                      <Link to="/integrations" style={{ fontSize: 13, fontWeight: 600, color: "#2563eb", flex: "none" }}>
                        Connect →
                      </Link>
                    </div>
                  );
                }
                const handle = connectionHandle(p, conn.shop_domain);
                const liveN = liveByPlatform(p);
                const draftN = draftsByPlatform(p);
                return (
                  <div key={p} style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 20px", borderTop: "1px solid #f1f5f9" }}>
                    <ChannelMonogram platform={p} size={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{meta.label}</div>
                      {handle && (
                        <div style={{ fontSize: 12.5, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {handle}
                        </div>
                      )}
                    </div>
                    <StatusPill status="live" label="Connected" />
                    <div style={{ width: 128, textAlign: "right", fontSize: 13, color: "#475569", flex: "none" }}>
                      <strong style={{ color: "#15803d" }}>{liveN}</strong> live · <strong style={{ color: "#1d4ed8" }}>{draftN}</strong> draft{draftN === 1 ? "" : "s"}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Recent activity */}
            <div className="tile" style={{ padding: "4px 0 10px" }}>
              <div style={{ padding: "16px 20px 8px" }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Recent activity</h2>
              </div>
              <div style={{ padding: "4px 20px 0" }}>
                {recentActivity.length === 0 ? (
                  <p style={{ fontSize: 13.5, color: "#64748b", margin: "6px 0 8px" }}>
                    No activity yet. Publish a draft or refresh to sync your channels.
                  </p>
                ) : (
                  recentActivity.map((a, i) => {
                    const isLast = i === recentActivity.length - 1;
                    return (
                      <div key={a.key} style={{ display: "flex", gap: 12, padding: "9px 0" }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none" }}>
                          <span className="status-dot" style={{ width: 10, height: 10, background: STATUS_META[a.kind].dot, marginTop: 3 }} aria-hidden />
                          {!isLast && <span style={{ width: 2, flex: 1, background: "#f1f5f9", marginTop: 4 }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0, paddingBottom: 2 }}>
                          <div style={{ fontSize: 13.5, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <strong style={{ fontWeight: 600 }}>{a.verb}</strong> — {a.title}
                          </div>
                          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 1 }}>{a.meta}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 18px", marginTop: 22, padding: "14px 18px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12 }}>
            <span className="kicker" style={{ color: "#94a3b8", marginRight: 4 }}>
              What the colors mean
            </span>
            {(["inprogress", "ready", "live", "sold", "failed", "ended"] as StatusKey[]).map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "#475569" }}>
                <span className="status-dot" style={{ background: STATUS_META[k].dot }} aria-hidden />
                {STATUS_META[k].label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
