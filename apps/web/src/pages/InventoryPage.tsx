import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";
import { supabase } from "../lib/supabase.js";

const PLATFORM_FROM_QUERY: Record<string, string> = {
  ebay: "eBay",
  shopify: "Shopify",
  depop: "Depop",
  poshmark: "Poshmark",
  mercari: "Mercari",
};

const ACTIVE_PLATFORM_LABEL: Record<string, string> = {
  ebay: "eBay",
  shopify: "Shopify",
  depop: "Depop",
  poshmark: "Poshmark",
  mercari: "Mercari",
};

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

/** User-visible SKU only: non-empty trim, excluding internal `inv-…` placeholders. */
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
  message?: string;
};

function formatSyncAllSummary(platforms: SyncAllPlatformResult[]): string {
  return platforms
    .map((p) => {
      const label = ACTIVE_PLATFORM_LABEL[p.platform] ?? p.platform;
      if (p.status === "ok") {
        const n = p.importedOrUpdated ?? 0;
        return `${label}: ${n} listing${n === 1 ? "" : "s"} pulled`;
      }
      const msg = p.message?.length ? (p.message.length > 72 ? `${p.message.slice(0, 69)}…` : p.message) : "skipped";
      return `${label}: ${msg}`;
    })
    .join(" · ");
}

type ActiveListingRow = {
  id: string;
  platform: string;
  /** When null, listing was synced from the marketplace and must not use app inventory fallbacks. */
  inventory_item_id: string | null;
  listing_url: string | null;
  /** Full listing title on the marketplace (eBay/Shopify); preferred over app inventory title. */
  listing_title: string | null;
  /** Primary image URL on the marketplace (set on sync/publish). */
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

/** Prefer `listing_url`; else derive eBay PDP from sync/publish metadata or Trading-only item id. */
function ebayListingPageUrl(row: ActiveListingRow): string | null {
  if (row.listing_url) return row.listing_url;
  if (row.platform !== "ebay") return null;
  const m = row.metadata as { ebayListingId?: string } | undefined;
  if (m?.ebayListingId && /^\d+$/.test(String(m.ebayListingId))) {
    return `https://www.ebay.com/itm/${m.ebayListingId}`;
  }
  if (
    row.inventory_item_id === null &&
    row.external_listing_id &&
    /^\d+$/.test(row.external_listing_id)
  ) {
    return `https://www.ebay.com/itm/${row.external_listing_id}`;
  }
  return null;
}

export function InventoryPage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const platformFromIntegrations = searchParams.get("platform");
  const platformLabel =
    platformFromIntegrations && PLATFORM_FROM_QUERY[platformFromIntegrations]
      ? PLATFORM_FROM_QUERY[platformFromIntegrations]
      : null;

  const { data: integData } = useQuery({
    queryKey: ["integrations"],
    queryFn: () =>
      apiFetch("/api/integrations") as Promise<{ connections: { platform: string }[] }>,
  });

  const { data: activeData, isLoading: activeLoading } = useQuery({
    queryKey: ["platform-listings", "live"],
    queryFn: () =>
      apiFetch("/api/platform-listings?status=live") as Promise<{ listings: ActiveListingRow[] }>,
  });

  const connected = new Set((integData?.connections ?? []).map((c) => c.platform));
  const activeListings = (activeData?.listings ?? []).filter((l) => connected.has(l.platform));

  const refreshInventory = useMutation({
    mutationFn: () =>
      apiFetch("/api/sync/all", { method: "POST", body: JSON.stringify({}) }) as Promise<{
        ok: boolean;
        platforms: SyncAllPlatformResult[];
      }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-listings", "live"] });
    },
  });

  return (
    <div>
      <h1>Inventory</h1>
      {platformLabel && (
        <p
          className="card"
          style={{ marginTop: 0, padding: "0.75rem 1rem", background: "#f1f5f9", borderColor: "#cbd5e1" }}
        >
          Adding listing drafts for <strong>{platformLabel}</strong> — use{" "}
          <Link to="/drafts">Listing drafts</Link> (includes all channels; paid plan where required).
        </p>
      )}
      <p
        className="card"
        style={{ marginTop: 0, padding: "0.75rem 1rem", color: "#475569", fontSize: "0.95rem" }}
      >
        To create new listing drafts, go to the{" "}
        <Link to="/drafts">Listing drafts</Link> page.
      </p>
      <div className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Active listings</h2>
          <button
            type="button"
            className="primary"
            disabled={connected.size === 0 || refreshInventory.isPending}
            title={
              connected.size === 0
                ? "Connect a marketplace under Integrations first"
                : "Pull the latest active listings from every connected marketplace"
            }
            onClick={() => refreshInventory.mutate()}
          >
            {refreshInventory.isPending ? "Refreshing…" : "Refresh inventory"}
          </button>
        </div>
        {refreshInventory.isError && (
          <p className="error" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            {(refreshInventory.error as Error).message}
          </p>
        )}
        {refreshInventory.isSuccess && refreshInventory.data?.platforms?.length ? (
          <p style={{ marginTop: "0.5rem", marginBottom: 0, color: "#64748b", fontSize: "0.9rem" }}>
            {formatSyncAllSummary(refreshInventory.data.platforms)}
          </p>
        ) : null}
        <p style={{ marginTop: "0.75rem", color: "#64748b", fontSize: "0.95rem" }}>
          Live listings from connected accounts (publish from <Link to="/drafts">Listing drafts</Link>).
        </p>
        {connected.size === 0 && (
          <p style={{ color: "#64748b" }}>
            Connect a marketplace under <Link to="/integrations">Integrations</Link> to see active listings here.
          </p>
        )}
        {activeLoading && <p>Loading listings…</p>}
        {connected.size > 0 && !activeLoading && activeListings.length === 0 && (
          <p style={{ marginBottom: 0 }}>No active listings yet for connected accounts.</p>
        )}
        {activeListings.length > 0 && (
          <table style={{ width: "100%", marginTop: "0.75rem" }}>
            <thead>
              <tr>
                <th>Photo</th>
                <th>Channel</th>
                <th>Name</th>
                <th>SKU</th>
                <th>Qty listed</th>
                <th>Listed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {activeListings.map((row) => {
                const inv = row.inventory_items;
                const linkedToAppInventory = Boolean(row.inventory_item_id);
                const invThumb = firstInventoryPhoto(inv?.inventory_images ?? null);
                const invThumbUrl = invThumb ? inventoryPhotoPublicUrl(invThumb) : null;
                const viewUrl = ebayListingPageUrl(row);
                const photoSrc =
                  row.listing_image_url ?? (linkedToAppInventory ? invThumbUrl : null);
                const photoHref = viewUrl ?? row.listing_image_url ?? invThumbUrl;
                /** Real inventory name, not API placeholder `New item`; else marketplace title. */
                const displayTitle = linkedToAppInventory
                  ? inventoryItemDisplayName(inv?.title, row.listing_title?.trim() || undefined)
                  : row.listing_title?.trim() || "—";
                const displaySku =
                  linkedToAppInventory ? userFacingInventorySku(inv?.sku) : null;
                const label = ACTIVE_PLATFORM_LABEL[row.platform] ?? row.platform;
                let listed = row.listed_at ?? "—";
                try {
                  if (row.listed_at) {
                    listed = new Date(row.listed_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    });
                  }
                } catch {
                  /* keep */
                }
                return (
                  <tr key={row.id}>
                    <td style={{ verticalAlign: "middle", width: 64 }}>
                      {photoSrc ? (
                        <a
                          href={photoHref ?? photoSrc}
                          target="_blank"
                          rel="noreferrer"
                          title="Open listing or photo"
                        >
                          <img
                            src={photoSrc}
                            alt=""
                            style={{
                              width: 52,
                              height: 52,
                              objectFit: "cover",
                              borderRadius: 4,
                              border: "1px solid #e2e8f0",
                              display: "block",
                            }}
                          />
                        </a>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>—</span>
                      )}
                    </td>
                    <td>{label}</td>
                    <td>{displayTitle}</td>
                    <td>
                      {displaySku ? (
                        displaySku
                      ) : (
                        <span style={{ color: "#94a3b8" }}>—</span>
                      )}
                    </td>
                    <td>{row.listed_quantity}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{listed}</td>
                    <td>
                      {viewUrl ? (
                        <a href={viewUrl} target="_blank" rel="noreferrer">
                          View listing
                        </a>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
