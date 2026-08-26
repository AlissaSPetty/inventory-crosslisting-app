import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";

const HYBRID_PLATFORMS = ["poshmark", "mercari"] as const;
type HybridPlatform = (typeof HYBRID_PLATFORMS)[number];

const PLATFORM_LABEL: Record<string, string> = { poshmark: "Poshmark", mercari: "Mercari" };

function isHybrid(p: string): p is HybridPlatform {
  return p === "poshmark" || p === "mercari";
}

type DraftRow = {
  id: string;
  inventory_item_id: string;
  platform: string;
  payload: Record<string, unknown>;
  inventory_items: { title: string; sku: string | null } | null;
};

type ManualListing = {
  id: string;
  platform: string;
  source: string;
  status: string;
  listing_url: string | null;
  listing_title: string | null;
  external_listing_id: string | null;
  listed_quantity: number;
  inventory_items: { id: string; title: string; sku: string | null } | null;
};

type Task = {
  id: string;
  platform: string | null;
  inventory_item_id: string | null;
  listing_url: string | null;
  targetQty: number | null;
  created_at: string;
};

function moneyFromCents(c: unknown): string {
  return typeof c === "number" ? `$${(c / 100).toFixed(2)}` : "—";
}

function tagsText(tags: unknown): string {
  return Array.isArray(tags) ? tags.filter(Boolean).map(String).join(", ") : "";
}

function draftFieldTitle(p: Record<string, unknown>): string {
  return typeof p.title === "string" ? p.title.trim() : "";
}

function draftFieldBody(p: Record<string, unknown>): string {
  return typeof p.body === "string" ? p.body.trim() : "";
}

function isDraftReady(d: DraftRow): boolean {
  return (
    d.payload?._generationPending !== true &&
    d.payload?._generationFailed !== true &&
    draftFieldTitle(d.payload ?? {}).length > 0
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => setCopied(false)
        );
      }}
      style={{ fontSize: "0.85rem", padding: "0.2rem 0.5rem" }}
      title={`Copy ${label.toLowerCase()} to clipboard`}
    >
      {copied ? "Copied!" : `Copy ${label}`}
    </button>
  );
}

export function HybridPage() {
  const qc = useQueryClient();

  const draftsQuery = useQuery({
    queryKey: ["hybrid", "drafts"],
    queryFn: () =>
      apiFetch("/api/listing-drafts?unpublished_only=true") as Promise<{ drafts: DraftRow[] }>,
    refetchInterval: (query) => {
      const list = (query.state.data as { drafts?: DraftRow[] } | undefined)?.drafts;
      const pending = list?.some(
        (d) => isHybrid(d.platform) && d.payload?._generationPending === true
      );
      return pending ? 2500 : false;
    },
  });

  const listingsQuery = useQuery({
    queryKey: ["platform-listings", "live"],
    queryFn: () =>
      apiFetch("/api/platform-listings?status=live") as Promise<{ listings: ManualListing[] }>,
  });

  const tasksQuery = useQuery({
    queryKey: ["sync-events", "manual"],
    queryFn: () =>
      apiFetch("/api/sync-events?type=manual_action_required&open=true") as Promise<{
        tasks: Task[];
      }>,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["hybrid", "drafts"] });
    qc.invalidateQueries({ queryKey: ["platform-listings"] });
    qc.invalidateQueries({ queryKey: ["sync-events"] });
    qc.invalidateQueries({ queryKey: ["listing-drafts"] });
  };

  const drafts = (draftsQuery.data?.drafts ?? []).filter((d) => isHybrid(d.platform));
  const manualListings = (listingsQuery.data?.listings ?? []).filter(
    (l) => isHybrid(l.platform) && l.source === "manual_link"
  );
  const tasks = tasksQuery.data?.tasks ?? [];

  return (
    <div>
      <h1>Poshmark &amp; Mercari</h1>
      <p style={{ color: "#64748b", fontSize: "0.95rem", marginTop: "0.5rem" }}>
        These marketplaces have no listing API, so posting is manual. Copy the AI draft copy below into the
        Poshmark or Mercari app, list it, then record the listing here so quantity and delisting stay in sync.
      </p>

      {/* Section C — manual to-dos (shown first when present so they aren't missed) */}
      {tasks.length > 0 && (
        <div className="card" style={{ marginTop: "1rem", background: "#fff7ed", borderColor: "#fdba74" }}>
          <h2 style={{ marginTop: 0 }}>Manual action needed ({tasks.length})</h2>
          <p style={{ marginTop: 0, color: "#9a3412", fontSize: "0.95rem" }}>
            An item sold elsewhere. Update quantity or delist these Poshmark/Mercari listings by hand, then mark
            them done.
          </p>
          <TaskList tasks={tasks} onDone={invalidateAll} />
        </div>
      )}

      {/* Section A — drafts to list manually */}
      <div className="card" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Drafts to list manually</h2>
        {draftsQuery.isLoading && <p>Loading drafts…</p>}
        {draftsQuery.error && <p className="error">{(draftsQuery.error as Error).message}</p>}
        {!draftsQuery.isLoading && drafts.length === 0 && (
          <p style={{ marginBottom: 0, color: "#64748b" }}>
            No Poshmark/Mercari drafts waiting. Create one from{" "}
            <Link to="/drafts/new">Add new draft</Link> (AI generates copy for every channel).
          </p>
        )}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} onListed={invalidateAll} />
        ))}
      </div>

      {/* Section B — recorded manual listings */}
      <div className="card" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Your manual listings</h2>
        {listingsQuery.isLoading && <p>Loading listings…</p>}
        {!listingsQuery.isLoading && manualListings.length === 0 && (
          <p style={{ marginBottom: 0, color: "#64748b" }}>
            No manual listings recorded yet. Use “Mark as listed” on a draft above after you post it.
          </p>
        )}
        {manualListings.map((l) => (
          <ManualListingRow key={l.id} listing={l} onChange={invalidateAll} />
        ))}
      </div>
    </div>
  );
}

function DraftCard({ draft, onListed }: { draft: DraftRow; onListed: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const p = draft.payload ?? {};
  const ready = isDraftReady(draft);
  const title = draftFieldTitle(p);
  const body = draftFieldBody(p);
  const price = moneyFromCents(p.price_hint_cents);
  const tags = tagsText(p.tags);
  const name = inventoryItemDisplayName(draft.inventory_items?.title, title || undefined);
  const label = PLATFORM_LABEL[draft.platform] ?? draft.platform;

  const copyAll = [title && `Title: ${title}`, body && `Description:\n${body}`, price !== "—" && `Price: ${price}`, tags && `Tags: ${tags}`]
    .filter(Boolean)
    .join("\n\n");

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "0.85rem", marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <strong>
          {name} · {label}
        </strong>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <CopyButton text={copyAll} label="all" />
          <button
            type="button"
            className="primary"
            disabled={!ready}
            title={ready ? "Record the listing you posted" : "Draft copy is still generating"}
            onClick={() => setShowForm((s) => !s)}
            style={{ fontSize: "0.85rem", padding: "0.2rem 0.6rem" }}
          >
            Mark as listed
          </button>
        </div>
      </div>

      {!ready ? (
        <p style={{ color: "#64748b", margin: "0.5rem 0 0", fontSize: "0.9rem" }}>
          {draft.payload?._generationFailed === true ? "AI copy generation failed." : "AI copy generating…"}
        </p>
      ) : (
        <dl style={{ margin: "0.5rem 0 0", display: "grid", gap: "0.4rem" }}>
          <Field label="Title" value={title} />
          <Field label="Description" value={body} multiline />
          <Field label="Price hint" value={price === "—" ? "" : price} />
          <Field label="Tags" value={tags} />
        </dl>
      )}

      {showForm && <MarkListedForm draft={draft} onDone={() => { setShowForm(false); onListed(); }} />}
    </div>
  );
}

function Field({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
      <span style={{ minWidth: 90, color: "#64748b", fontSize: "0.85rem" }}>{label}</span>
      <span
        style={{
          flex: 1,
          whiteSpace: multiline ? "pre-wrap" : "normal",
          wordBreak: "break-word",
          fontSize: "0.9rem",
        }}
      >
        {value}
      </span>
      <CopyButton text={value} label={label} />
    </div>
  );
}

function MarkListedForm({ draft, onDone }: { draft: DraftRow; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [externalId, setExternalId] = useState("");
  const [qty, setQty] = useState("1");

  const markListed = useMutation({
    mutationFn: () =>
      apiFetch(`/api/listing-drafts/${draft.id}/mark-listed`, {
        method: "POST",
        body: JSON.stringify({
          platform: draft.platform,
          listing_url: url.trim(),
          external_listing_id: externalId.trim() || undefined,
          listed_quantity: Number.isFinite(Number(qty)) ? Math.max(0, Math.floor(Number(qty))) : 1,
        }),
      }) as Promise<{ ok: boolean }>,
    onSuccess: onDone,
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim()) return;
        markListed.mutate();
      }}
      style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem", maxWidth: 480 }}
    >
      <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
        Listing URL (required)
        <input
          type="url"
          required
          placeholder="https://poshmark.com/listing/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
        Listing ID (optional)
        <input value={externalId} onChange={(e) => setExternalId(e.target.value)} />
      </label>
      <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
        Quantity
        <input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 120 }} />
      </label>
      {markListed.isError && <p className="error" style={{ margin: 0 }}>{(markListed.error as Error).message}</p>}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="submit" className="primary" disabled={markListed.isPending || !url.trim()}>
          {markListed.isPending ? "Saving…" : "Save listing"}
        </button>
      </div>
    </form>
  );
}

function ManualListingRow({ listing, onChange }: { listing: ManualListing; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [url, setUrl] = useState(listing.listing_url ?? "");
  const [qty, setQty] = useState(String(listing.listed_quantity));
  const [title, setTitle] = useState(listing.listing_title ?? "");
  const label = PLATFORM_LABEL[listing.platform] ?? listing.platform;
  const name = inventoryItemDisplayName(listing.inventory_items?.title, listing.listing_title ?? undefined);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/platform-listings/${listing.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }) as Promise<{ listing: ManualListing }>,
    onSuccess: () => {
      setEditing(false);
      onChange();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      apiFetch(`/api/platform-listings/${listing.id}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,
    onSuccess: onChange,
  });

  const busy = patch.isPending || remove.isPending;

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "0.75rem", marginBottom: "0.6rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <strong>{name}</strong> · {label} · qty {listing.listed_quantity}
          {listing.listing_url && (
            <>
              {" · "}
              <a href={listing.listing_url} target="_blank" rel="noreferrer">
                View listing
              </a>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => setEditing((s) => !s)} style={{ fontSize: "0.85rem" }}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => patch.mutate({ status: "ended" })}
            title="Mark this listing ended (removes it from active listings)"
            style={{ fontSize: "0.85rem" }}
          >
            Mark ended
          </button>
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => remove.mutate()}
                style={{ fontSize: "0.85rem" }}
              >
                {remove.isPending ? "Removing…" : "Confirm remove"}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmRemove(false)} style={{ fontSize: "0.85rem" }}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)} style={{ fontSize: "0.85rem" }}>
              Remove
            </button>
          )}
        </div>
      </div>

      {(patch.isError || remove.isError) && (
        <p className="error" style={{ margin: "0.4rem 0 0" }}>
          {((patch.error ?? remove.error) as Error)?.message}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patch.mutate({
              listing_url: url.trim(),
              listing_title: title.trim(),
              listed_quantity: Number.isFinite(Number(qty)) ? Math.max(0, Math.floor(Number(qty))) : 0,
            });
          }}
          style={{ marginTop: "0.6rem", display: "grid", gap: "0.5rem", maxWidth: 480 }}
        >
          <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
            Listing URL
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.85rem" }}>
            Quantity
            <input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 120 }} />
          </label>
          <div>
            <button type="submit" className="primary" disabled={patch.isPending}>
              {patch.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function TaskList({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: "0.5rem" }}>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} onDone={onDone} />
      ))}
    </ul>
  );
}

function TaskRow({ task, onDone }: { task: Task; onDone: () => void }) {
  const label = task.platform ? PLATFORM_LABEL[task.platform] ?? task.platform : "marketplace";
  const ack = useMutation({
    mutationFn: () =>
      apiFetch(`/api/sync-events/${task.id}/ack`, { method: "POST" }) as Promise<{ ok: boolean }>,
    onSuccess: onDone,
  });
  return (
    <li style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
      <span style={{ fontSize: "0.92rem" }}>
        Delist / set qty to {task.targetQty ?? 0} on <strong>{label}</strong>
        {task.listing_url && (
          <>
            {" — "}
            <a href={task.listing_url} target="_blank" rel="noreferrer">
              open listing
            </a>
          </>
        )}
      </span>
      <button type="button" disabled={ack.isPending} onClick={() => ack.mutate()} style={{ fontSize: "0.85rem" }}>
        {ack.isPending ? "…" : "I did this"}
      </button>
    </li>
  );
}
