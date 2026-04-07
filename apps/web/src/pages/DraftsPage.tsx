import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";
import { supabase } from "../lib/supabase.js";

type Connection = {
  platform: string;
  shop_domain: string | null;
};

type InventoryImageRow = {
  id: string;
  storage_path: string;
  sort_order: number;
  file_updated_at?: string | null;
};

type DraftRow = {
  id: string;
  inventory_item_id: string;
  platform: string;
  updated_at: string;
  payload: Record<string, unknown>;
  inventory_items: {
    title: string;
    sku: string | null;
    draft_ai_status?: string | null;
    inventory_images?: InventoryImageRow[] | null;
  } | null;
};

const PLATFORM_LABEL: Record<string, string> = {
  ebay: "eBay",
  shopify: "Shopify",
  depop: "Depop",
  poshmark: "Poshmark",
  mercari: "Mercari",
};

function publicListingPhotoUrl(storagePath: string): string {
  const { data } = supabase.storage.from("listing-photos").getPublicUrl(storagePath);
  return data.publicUrl;
}

function inventoryPhotoHref(im: InventoryImageRow): string {
  const base = publicListingPhotoUrl(im.storage_path);
  const t = im.file_updated_at;
  if (typeof t === "string" && t.length) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return `${base}?v=${ms}`;
  }
  return base;
}

function isDraftRowProcessing(d: DraftRow): boolean {
  return (
    d.inventory_items?.draft_ai_status === "pending" ||
    d.payload?._generationPending === true
  );
}

function isDraftRowFailed(d: DraftRow): boolean {
  return (
    d.inventory_items?.draft_ai_status === "failed" || d.payload?._generationFailed === true
  );
}

function rawDraftTitleFromPayload(payload: Record<string, unknown>): string | undefined {
  if (payload._generationPending === true || payload._generationFailed === true) return undefined;
  const t = payload.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  return undefined;
}

function draftPriceHint(payload: Record<string, unknown>): string {
  const c = payload.price_hint_cents;
  if (typeof c === "number") return `$${(c / 100).toFixed(2)}`;
  return "—";
}

function draftTags(payload: Record<string, unknown>): string {
  const tags = payload.tags;
  if (Array.isArray(tags)) return tags.filter(Boolean).map(String).join(", ") || "—";
  return "—";
}

export function DraftsPage() {
  const { data: integrations } = useQuery({
    queryKey: ["integrations"],
    queryFn: () =>
      apiFetch("/api/integrations") as Promise<{ connections: Connection[] }>,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["listing-drafts", "unpublished"],
    queryFn: () =>
      apiFetch("/api/listing-drafts?unpublished_only=true") as Promise<{ drafts: DraftRow[] }>,
    refetchInterval: (query) => {
      const list = (query.state.data as { drafts?: DraftRow[] } | undefined)?.drafts;
      if (!list?.length) return false;
      return list.some(isDraftRowProcessing) ? 2500 : false;
    },
  });

  const connections = integrations?.connections ?? [];
  const connected = new Set(connections.map((c) => c.platform));
  const drafts = data?.drafts ?? [];

  /** Unpublished drafts for platforms the user has connected (marketplaces we can publish to). */
  const visibleDrafts = drafts.filter((d) => connected.has(d.platform));

  const byPlatform = (p: string) => visibleDrafts.filter((d) => d.platform === p);

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <h1 style={{ margin: 0 }}>Listing drafts</h1>
        <Link
          to="/drafts/new"
          style={{
            display: "inline-block",
            padding: "0.4rem 0.75rem",
            borderRadius: 6,
            background: "#2563eb",
            color: "#fff",
            textDecoration: "none",
            border: "1px solid #2563eb",
            fontSize: "0.95rem",
          }}
        >
          Add new draft
        </Link>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.95rem", marginTop: "0.75rem" }}>
        Unpublished drafts only (after you publish, a draft disappears from this list). Start from{" "}
        <Link to="/drafts/new">Add new draft</Link> (photos + AI) or manage live listings on{" "}
        <Link to="/inventory">Inventory</Link>.
      </p>

      {connections.length === 0 && (
        <p className="card" style={{ background: "#fff7ed", borderColor: "#fdba74" }}>
          Connect eBay or Shopify under <Link to="/integrations">Integrations</Link> to publish drafts.
        </p>
      )}

      {isLoading && <p>Loading drafts…</p>}
      {error && <p className="error">{(error as Error).message}</p>}

      {["ebay", "shopify", "depop", "poshmark", "mercari"].map((platform) => {
        if (!connected.has(platform)) return null;
        const rows = byPlatform(platform);
        const label = PLATFORM_LABEL[platform] ?? platform;
        return (
          <div key={platform} className="card" style={{ marginTop: "1rem" }}>
            <h2 style={{ marginTop: 0 }}>{label}</h2>
            {rows.length === 0 ? (
              <p style={{ marginBottom: 0, color: "#64748b" }}>No unpublished {label} drafts.</p>
            ) : (
              <DraftTable rows={rows} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DraftTable({ rows }: { rows: DraftRow[] }) {
  const qc = useQueryClient();
  const deleteItem = useMutation({
    mutationFn: (inventoryItemId: string) =>
      apiFetch(`/api/inventory/${inventoryItemId}`, { method: "DELETE" }) as Promise<undefined>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["platform-listings"] });
    },
  });

  return (
    <>
      {deleteItem.isError && (
        <p className="error" style={{ marginBottom: "0.5rem" }}>
          {(deleteItem.error as Error).message}
        </p>
      )}
      <table style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Photos</th>
          <th>Name</th>
          <th>Price hint</th>
          <th>Tags</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => {
          const p = d.payload ?? {};
          const processing = isDraftRowProcessing(d);
          const failed = isDraftRowFailed(d);
          const displayName = processing
            ? "Processing…"
            : failed
              ? "—"
              : inventoryItemDisplayName(d.inventory_items?.title, rawDraftTitleFromPayload(p));
          const images = [...(d.inventory_items?.inventory_images ?? [])].sort(
            (a, b) => a.sort_order - b.sort_order
          );
          let updated = d.updated_at;
          try {
            updated = new Date(d.updated_at).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            });
          } catch {
            /* keep raw */
          }
          return (
            <tr key={d.id}>
              <td style={{ verticalAlign: "middle" }}>
                {images.length === 0 ? (
                  <span style={{ color: "#94a3b8" }}>—</span>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 200 }}>
                    {images.map((im) => (
                      <a
                        key={im.id}
                        href={inventoryPhotoHref(im)}
                        target="_blank"
                        rel="noreferrer"
                        title={im.storage_path}
                      >
                        <img
                          src={inventoryPhotoHref(im)}
                          alt={`Photo for ${displayName}`}
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
                    ))}
                  </div>
                )}
              </td>
              <td style={{ maxWidth: 320 }}>{displayName}</td>
              <td>{draftPriceHint(p)}</td>
              <td style={{ maxWidth: 200, wordBreak: "break-word" }}>{draftTags(p)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{updated}</td>
              <td>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", alignItems: "flex-start" }}>
                  {processing ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.35rem",
                        color: "#64748b",
                        fontSize: "0.95rem",
                      }}
                    >
                      <span className="draft-row-spinner" aria-hidden />
                      Processing
                    </span>
                  ) : failed ? (
                    <span style={{ color: "#b91c1c", fontSize: "0.9rem", maxWidth: 200 }}>
                      {typeof p._error === "string" && p._error.trim()
                        ? p._error.trim().length > 120
                          ? `${p._error.trim().slice(0, 117)}…`
                          : p._error.trim()
                        : "Generation failed"}
                    </span>
                  ) : (
                    <Link to={`/drafts/${d.id}`}>Edit & publish</Link>
                  )}
                  <button
                    type="button"
                    disabled={deleteItem.isPending}
                    title="Removes this inventory item, all unpublished drafts for every channel, linked marketplace rows, and stored photos."
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Delete this inventory item? All listing drafts for every platform and all photos will be permanently removed. This cannot be undone."
                        )
                      ) {
                        return;
                      }
                      deleteItem.mutate(d.inventory_item_id);
                    }}
                  >
                    Delete item
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </>
  );
}
