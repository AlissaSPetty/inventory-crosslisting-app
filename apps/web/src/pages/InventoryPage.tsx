import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";
import { supabase } from "../lib/supabase.js";
import {
  ChannelMonogram,
  STATUS_META,
  StatusPill,
  platformLabel,
  type StatusKey,
} from "../lib/listingsUi.js";

type InventoryImageRow = {
  id: string;
  storage_path: string;
  sort_order: number;
  file_updated_at?: string | null;
};

function inventoryPhotoPublicUrl(im: InventoryImageRow): string {
  const { data } = supabase.storage.from("listing-photos").getPublicUrl(im.storage_path);
  const base = data.publicUrl;
  const t = im.file_updated_at;
  if (typeof t === "string" && t.length) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return `${base}?v=${ms}`;
  }
  return base;
}

function firstInventoryPhoto(images: InventoryImageRow[] | null | undefined): InventoryImageRow | null {
  if (!images?.length) return null;
  return [...images].sort((a, b) => a.sort_order - b.sort_order)[0] ?? null;
}

/** Matches auto-generated SKUs from `apps/api/src/routes/drafts.ts` (`inv-` + first 32 hex chars of inventory id). */
const AUTO_INVENTORY_SKU_RE = /^inv-[a-f0-9]{32}$/i;

function userFacingInventorySku(sku: string | null | undefined): string | null {
  if (sku == null || typeof sku !== "string") return null;
  const t = sku.trim();
  if (!t || AUTO_INVENTORY_SKU_RE.test(t)) return null;
  return t;
}

type SyncAllPlatformResult = {
  platform: string;
  status: "ok" | "skipped";
  importedOrUpdated?: number;
  listingsProcessedFromApi?: number;
  message?: string;
};

function formatSyncAllSummary(platforms: SyncAllPlatformResult[]): string {
  return platforms
    .map((p) => {
      const label = platformLabel(p.platform);
      if (p.status === "ok") {
        const n = p.importedOrUpdated ?? 0;
        const processed = p.listingsProcessedFromApi;
        const base = `${label}: ${n} active listing${n === 1 ? "" : "s"} in app`;
        if (typeof processed === "number" && processed !== n) {
          return `${base} (${processed} processed from API this run)`;
        }
        return base;
      }
      const msg = p.message?.length ? (p.message.length > 72 ? `${p.message.slice(0, 69)}…` : p.message) : "skipped";
      return `${label}: ${msg}`;
    })
    .join(" · ");
}

type ListingRow = {
  id: string;
  platform: string;
  status: string;
  inventory_item_id: string | null;
  listing_url: string | null;
  listing_title: string | null;
  listing_image_url: string | null;
  external_listing_id: string | null;
  listed_quantity: number;
  listed_at: string | null;
  shop_domain: string | null;
  metadata?: Record<string, unknown> | null;
  inventory_items: {
    id: string;
    title: string;
    sku: string | null;
    inventory_images?: InventoryImageRow[] | null;
  } | null;
};

function ebayListingPageUrl(row: ListingRow): string | null {
  if (row.listing_url) return row.listing_url;
  if (row.platform !== "ebay") return null;
  const m = row.metadata as { ebayListingId?: string } | undefined;
  if (m?.ebayListingId && /^\d+$/.test(String(m.ebayListingId))) {
    return `https://www.ebay.com/itm/${m.ebayListingId}`;
  }
  if (row.inventory_item_id === null && row.external_listing_id && /^\d+$/.test(row.external_listing_id)) {
    return `https://www.ebay.com/itm/${row.external_listing_id}`;
  }
  return null;
}

const ROW_GRID = "44px minmax(0, 1.7fr) 150px 118px 110px 56px 104px 88px";

function PhotoThumb({ src, soft }: { src: string | null; soft: string }) {
  if (src) {
    return <img src={src} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0", display: "block" }} />;
  }
  return (
    <span style={{ width: 44, height: 44, borderRadius: 8, background: soft, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </span>
  );
}

type Filter = "all" | "live" | "ended";

export function InventoryPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");

  const { data: integData } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => apiFetch("/api/integrations") as Promise<{ connections: { platform: string }[] }>,
  });

  const { data: liveData, isLoading: liveLoading } = useQuery({
    queryKey: ["platform-listings", "live"],
    queryFn: () => apiFetch("/api/platform-listings?status=live") as Promise<{ listings: ListingRow[] }>,
  });

  const { data: endedData, isLoading: endedLoading } = useQuery({
    queryKey: ["platform-listings", "ended"],
    queryFn: () => apiFetch("/api/platform-listings?status=ended") as Promise<{ listings: ListingRow[] }>,
  });

  const connected = new Set((integData?.connections ?? []).map((c) => c.platform));

  const rows = useMemo(() => {
    const live = (liveData?.listings ?? []).map((r) => ({ ...r, statusKey: "live" as StatusKey }));
    const ended = (endedData?.listings ?? []).map((r) => ({ ...r, statusKey: "ended" as StatusKey }));
    return [...live, ...ended]
      .filter((r) => connected.has(r.platform))
      .sort((a, b) => (Date.parse(b.listed_at ?? "") || 0) - (Date.parse(a.listed_at ?? "") || 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveData, endedData, integData]);

  const counts = {
    all: rows.length,
    live: rows.filter((r) => r.statusKey === "live").length,
    ended: rows.filter((r) => r.statusKey === "ended").length,
  };
  const visible = filter === "all" ? rows : rows.filter((r) => r.statusKey === filter);
  const loading = liveLoading || endedLoading;

  const refreshInventory = useMutation({
    mutationFn: () =>
      apiFetch("/api/sync/all", { method: "POST", body: JSON.stringify({}) }) as Promise<{
        ok: boolean;
        platforms: SyncAllPlatformResult[];
      }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-listings"] });
    },
  });

  const chips: { key: Filter; label: string; count: number; dot?: string }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "live", label: "Live", count: counts.live, dot: STATUS_META.live.dot },
    { key: "ended", label: "Ended", count: counts.ended, dot: STATUS_META.ended.dot },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em" }}>Active listings</h1>
          <p style={{ margin: "5px 0 0", fontSize: 14, color: "#64748b" }}>
            Every listing and where it stands, across all connected marketplaces.
          </p>
        </div>
        <button
          type="button"
          className="appbtn primary"
          disabled={connected.size === 0 || refreshInventory.isPending}
          title={connected.size === 0 ? "Connect a marketplace under Integrations first" : "Pull the latest listings from every connected marketplace"}
          onClick={() => refreshInventory.mutate()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {refreshInventory.isPending ? "Refreshing…" : "Refresh inventory"}
        </button>
      </div>

      {refreshInventory.isError && (
        <p className="error" style={{ marginTop: 0 }}>
          {(refreshInventory.error as Error).message}
        </p>
      )}
      {refreshInventory.isSuccess && refreshInventory.data?.platforms?.length ? (
        <p style={{ marginTop: 0, marginBottom: 14, color: "#64748b", fontSize: 13 }}>
          {formatSyncAllSummary(refreshInventory.data.platforms)}
        </p>
      ) : null}

      {connected.size === 0 && (
        <div className="tile" style={{ padding: "22px 24px" }}>
          <p style={{ margin: 0, color: "#64748b" }}>
            Connect a marketplace under <Link to="/integrations">Integrations</Link> to see listings here.
          </p>
        </div>
      )}

      {connected.size > 0 && (
        <>
          {/* Filters */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16, flexWrap: "wrap" }}>
            {chips.map((c) => (
              <button key={c.key} type="button" className={`chip${filter === c.key ? " active" : ""}`} onClick={() => setFilter(c.key)}>
                {c.dot && <span className="status-dot" style={{ background: c.dot }} aria-hidden />}
                {c.label} · {c.count}
              </button>
            ))}
          </div>

          {/* Table */}
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: ROW_GRID, alignItems: "center", gap: 14, padding: "11px 20px", background: "#fbfcfe", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "#94a3b8" }}>
              <span />
              <span>Item</span>
              <span>Channel</span>
              <span>Status</span>
              <span>SKU</span>
              <span style={{ textAlign: "right" }}>Qty</span>
              <span style={{ textAlign: "right" }}>Listed</span>
              <span style={{ textAlign: "right" }} />
            </div>

            {loading && (
              <div style={{ padding: "18px 20px", color: "#64748b", fontSize: 14 }}>Loading listings…</div>
            )}
            {!loading && visible.length === 0 && (
              <div style={{ padding: "18px 20px", color: "#64748b", fontSize: 14 }}>
                {rows.length === 0 ? "No listings yet for connected accounts." : "No listings match this filter."}
              </div>
            )}

            {!loading &&
              visible.map((row) => {
                const inv = row.inventory_items;
                const linkedToApp = Boolean(row.inventory_item_id);
                const invThumb = firstInventoryPhoto(inv?.inventory_images ?? null);
                const invThumbUrl = invThumb ? inventoryPhotoPublicUrl(invThumb) : null;
                const viewUrl = ebayListingPageUrl(row);
                const photoSrc = row.listing_image_url ?? (linkedToApp ? invThumbUrl : null);
                const displayTitle = linkedToApp
                  ? inventoryItemDisplayName(inv?.title, row.listing_title?.trim() || undefined)
                  : row.listing_title?.trim() || "—";
                const displaySku = linkedToApp ? userFacingInventorySku(inv?.sku) : null;
                const ended = row.statusKey === "ended";
                let listed = "—";
                if (row.listed_at) {
                  try {
                    listed = new Date(row.listed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
                  } catch {
                    listed = row.listed_at;
                  }
                }
                return (
                  <div key={row.id} style={{ display: "grid", gridTemplateColumns: ROW_GRID, alignItems: "center", gap: 14, padding: "8px 20px", borderTop: "1px solid #f1f5f9", minHeight: 56 }}>
                    <PhotoThumb src={photoSrc} soft={ended ? STATUS_META.ended.soft : STATUS_META.live.soft} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: ended ? "#64748b" : "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {displayTitle}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <ChannelMonogram platform={row.platform} />
                      <span style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{platformLabel(row.platform)}</span>
                    </div>
                    <div>
                      <StatusPill status={row.statusKey} />
                    </div>
                    <div style={{ fontSize: 13, color: displaySku ? "#64748b" : "#cbd5e1", fontVariantNumeric: "tabular-nums" }}>
                      {displaySku ?? "—"}
                    </div>
                    <div style={{ fontSize: 13.5, textAlign: "right", fontVariantNumeric: "tabular-nums", color: ended ? "#94a3b8" : "#0f172a" }}>
                      {row.listed_quantity}
                    </div>
                    <div style={{ fontSize: 13, color: "#64748b", textAlign: "right", whiteSpace: "nowrap" }}>{listed}</div>
                    <div style={{ textAlign: "right", fontSize: 13 }}>
                      {viewUrl ? (
                        <a href={viewUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                          View
                        </a>
                      ) : (
                        <span style={{ color: "#cbd5e1" }}>—</span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {!loading && rows.length > 0 && (
            <p style={{ margin: "14px 2px 0", fontSize: 12.5, color: "#64748b" }}>
              Showing {visible.length} of {rows.length} listing{rows.length === 1 ? "" : "s"} · live listings sync from connected marketplaces; publish new ones from{" "}
              <Link to="/drafts">Listing drafts</Link>.
            </p>
          )}
        </>
      )}
    </div>
  );
}
