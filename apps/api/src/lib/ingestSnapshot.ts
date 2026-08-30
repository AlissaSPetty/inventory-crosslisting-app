import type { SupabaseClient } from "@supabase/supabase-js";
import type { ListingSource, Platform } from "@inv/shared";
import type { NormalizedListing } from "./adapters/types.js";

/** Drop routine sync audit rows so per-user `sync_events` does not grow without bound. */
const INVENTORY_FETCH_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A snapshot claiming completeness whose live count collapsed to below this
 * fraction of the previous live count is treated as a failed/partial scrape and
 * pruning is skipped, protecting rows from a half-drained cursor that still
 * reported `complete`.
 */
const IMPLAUSIBLE_DROP_FRACTION = 0.2;
const IMPLAUSIBLE_DROP_MIN_PREV = 5;

/** PostgREST caps a select at ~1000 rows — page the existing-row load. */
const SELECT_PAGE = 1000;
/** Bounded parallelism for per-row updates (large closets = thousands of rows). */
const WRITE_CONCURRENCY = 12;
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 200;

export type IngestSnapshotOptions = {
  shopDomain?: string | null;
  prune: boolean;
  complete?: boolean;
  source?: ListingSource;
  eventType?: string;
  eventPayloadExtra?: Record<string, unknown>;
};

export type IngestSnapshotResult = {
  listingsProcessed: number;
  importedOrUpdated: number;
  pruned: number;
  pruneSkipped: boolean;
  pruneSkippedReason?: string;
};

type ExistingRow = {
  id: string;
  external_listing_id: string | null;
  source: string | null;
  status: string | null;
  inventory_item_id: string | null;
  metadata: Record<string, unknown> | null;
  listed_quantity: number | null;
  listing_title: string | null;
  listing_url: string | null;
  listing_image_url: string | null;
};

const EXISTING_COLS =
  "id, external_listing_id, source, status, inventory_item_id, metadata, listed_quantity, listing_title, listing_url, listing_image_url";

function nextRowStatus(
  listingStatus: string,
  prev: { status?: string | null; inventory_item_id?: string | null } | null
): string {
  const linked = !!prev?.inventory_item_id;
  if (listingStatus === "sold") return "sold";
  if (!prev) return "pending_link";
  if (prev.status === "sold") return linked ? "active" : "pending_link";
  if (prev.status === "active" || linked) return "active";
  return prev.status ?? "pending_link";
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Load every existing row for (user, platform) — paged past PostgREST's row cap. */
async function loadExisting(
  service: SupabaseClient,
  userId: string,
  platform: Platform
): Promise<ExistingRow[]> {
  const rows: ExistingRow[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data } = await service
      .from("platform_listings")
      .select(EXISTING_COLS)
      .eq("user_id", userId)
      .eq("platform", platform)
      .range(from, from + SELECT_PAGE - 1);
    const batch = (data ?? []) as ExistingRow[];
    rows.push(...batch);
    if (batch.length < SELECT_PAGE) break;
  }
  return rows;
}

async function trimOldInventoryFetchSyncEvents(
  service: SupabaseClient,
  userId: string,
  eventType: string,
  nowMs: number
): Promise<void> {
  const cutoff = new Date(nowMs - INVENTORY_FETCH_EVENT_RETENTION_MS).toISOString();
  await service
    .from("sync_events")
    .delete()
    .eq("user_id", userId)
    .eq("event_type", eventType)
    .lt("created_at", cutoff);
}

/**
 * Upsert a marketplace listing snapshot into `platform_listings`, then optionally
 * prune rows absent from the snapshot. Shared by the API sync path
 * (`executePlatformListingsSync`, non-eBay) and the extension push endpoint.
 *
 * Scales to large closets (thousands of listings): existing rows are loaded once
 * (paged), new rows are bulk-inserted, updates run with bounded concurrency, and
 * stale rows are bulk-deleted. Match key is `(user_id, platform,
 * external_listing_id)`. `manual_link` rows keep their title/image/metadata; only
 * factual marketplace state (quantity, status, url) is refreshed. Prune only ever
 * removes rows of the configured `source`.
 */
export async function ingestListingSnapshot(
  service: SupabaseClient,
  userId: string,
  platform: Platform,
  listings: NormalizedListing[],
  opts: IngestSnapshotOptions
): Promise<IngestSnapshotResult> {
  const source: ListingSource = opts.source ?? "sync_fetch";
  const eventType = opts.eventType ?? "inventory_fetch_completed";
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const existing = await loadExisting(service, userId, platform);
  const byExt = new Map<string, ExistingRow>();
  let prevLiveCount = 0;
  for (const r of existing) {
    if (r.external_listing_id != null) byExt.set(r.external_listing_id, r);
    if (r.status === "active" || r.status === "pending_link") prevLiveCount++;
  }

  const touched = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];

  // Updates run concurrently against existing rows; new rows are collected for bulk insert.
  await mapPool(listings, WRITE_CONCURRENCY, async (listing) => {
    const ex = byExt.get(listing.externalListingId) ?? null;
    const rowStatus = nextRowStatus(listing.status, ex);
    if (ex) {
      touched.add(ex.id);
      const isManual = ex.source === "manual_link";
      // Skip rows whose material fields are unchanged — a large re-sync then only
      // writes what actually changed (price drops, sold, new/removed listings).
      const desiredTitle = isManual ? ex.listing_title : listing.title;
      const desiredImage = isManual
        ? ex.listing_image_url
        : listing.imageUrl ?? (source === "sync_fetch" ? null : ex.listing_image_url);
      const desiredUrl = listing.url ?? ex.listing_url;
      const exPrice = (ex.metadata as { priceCents?: unknown } | null)?.priceCents ?? null;
      const newPrice = (listing.metadata as { priceCents?: unknown } | undefined)?.priceCents ?? null;
      const unchanged =
        ex.status === rowStatus &&
        (ex.listed_quantity ?? null) === listing.quantity &&
        (ex.listing_title ?? null) === (desiredTitle ?? null) &&
        (ex.listing_image_url ?? null) === (desiredImage ?? null) &&
        (ex.listing_url ?? null) === (desiredUrl ?? null) &&
        exPrice === newPrice;
      if (unchanged) return;
      const mergedMeta = {
        ...((ex.metadata as Record<string, unknown>) ?? {}),
        ...((listing.metadata as Record<string, unknown>) ?? {}),
      };
      const update: Record<string, unknown> = {
        listed_quantity: listing.quantity,
        status: rowStatus,
        metadata: mergedMeta,
        ...(listing.url ? { listing_url: listing.url } : {}),
        ...(listing.listedAt ? { listed_at: listing.listedAt } : {}),
        last_synced_at: nowIso,
        updated_at: nowIso,
      };
      if (!isManual) {
        update.listing_title = listing.title;
        if (listing.imageUrl) update.listing_image_url = listing.imageUrl;
        else if (source === "sync_fetch") update.listing_image_url = null;
      }
      await service.from("platform_listings").update(update).eq("id", ex.id);
    } else {
      toInsert.push({
        user_id: userId,
        inventory_item_id: null,
        platform,
        external_listing_id: listing.externalListingId,
        shop_domain: opts.shopDomain ?? null,
        listing_url: listing.url ?? null,
        listing_title: listing.title,
        listing_image_url: listing.imageUrl ?? null,
        listed_at: listing.listedAt ?? nowIso,
        status: rowStatus,
        listed_quantity: listing.quantity,
        source,
        metadata: listing.metadata ?? {},
        last_synced_at: nowIso,
      });
    }
  });

  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK);
    const { data: inserted } = await service.from("platform_listings").insert(chunk).select("id");
    for (const r of (inserted ?? []) as { id: string }[]) touched.add(r.id);
  }

  // Prune: remove rows of this source absent from the snapshot — but only when the
  // snapshot is trustworthy (complete + non-empty + no implausible collapse).
  let pruned = 0;
  let pruneSkipped = false;
  let pruneSkippedReason: string | undefined;
  if (!opts.prune) {
    pruneSkipped = true;
    pruneSkippedReason = "prune_disabled";
  } else if (opts.complete === false) {
    pruneSkipped = true;
    pruneSkippedReason = "snapshot_incomplete";
  } else if (listings.length === 0) {
    pruneSkipped = true;
    pruneSkippedReason = "empty_snapshot";
  } else if (
    prevLiveCount >= IMPLAUSIBLE_DROP_MIN_PREV &&
    touched.size < prevLiveCount * IMPLAUSIBLE_DROP_FRACTION
  ) {
    pruneSkipped = true;
    pruneSkippedReason = "implausible_drop";
  }

  if (!pruneSkipped) {
    const staleIds = existing.filter((r) => r.source === source && !touched.has(r.id)).map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += DELETE_CHUNK) {
      const chunk = staleIds.slice(i, i + DELETE_CHUNK);
      if (chunk.length === 0) continue;
      await service.from("platform_listings").delete().in("id", chunk);
      pruned += chunk.length;
    }
  }

  const { count: liveCount } = await service
    .from("platform_listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", platform)
    .in("status", ["active", "pending_link"]);
  const live = liveCount ?? 0;

  await trimOldInventoryFetchSyncEvents(service, userId, eventType, nowMs);
  await service.from("sync_events").insert({
    user_id: userId,
    event_type: eventType,
    payload: {
      platform,
      listingsProcessed: listings.length,
      liveListingsInApp: live,
      pruned,
      ...(pruneSkipped ? { pruneSkipped, pruneSkippedReason } : {}),
      ...(opts.eventPayloadExtra ?? {}),
    },
  });

  return {
    listingsProcessed: listings.length,
    importedOrUpdated: live,
    pruned,
    pruneSkipped,
    pruneSkippedReason,
  };
}
