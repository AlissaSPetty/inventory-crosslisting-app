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

export type IngestSnapshotOptions = {
  /** Stored on newly inserted rows (mirrors `integration_credentials.shop_domain`). */
  shopDomain?: string | null;
  /** Attempt to prune rows absent from this snapshot. Only honored when `complete`. */
  prune: boolean;
  /**
   * True only when the caller fully drained the source cursor. Pruning a partial
   * snapshot would delete every row not in the partial set — so prune requires this.
   */
  complete?: boolean;
  /** Row source for inserts + prune scope. Defaults to `sync_fetch`. */
  source?: ListingSource;
  /** `sync_events.event_type` recorded at the end. Defaults to `inventory_fetch_completed`. */
  eventType?: string;
  /** Extra fields merged into the completion event payload (e.g. `{ origin: 'extension' }`). */
  eventPayloadExtra?: Record<string, unknown>;
};

export type IngestSnapshotResult = {
  /** Listings processed from the snapshot this run. */
  listingsProcessed: number;
  /** Live `platform_listings` for this platform after ingest+prune (`active` | `pending_link`). */
  importedOrUpdated: number;
  pruned: number;
  pruneSkipped: boolean;
  pruneSkippedReason?: string;
};

type PrevRow = {
  status?: string | null;
  inventory_item_id?: string | null;
};

/**
 * Map a normalized listing status to a `platform_listings.status`.
 * - `sold` → `sold` (kept for history; never pruned).
 * - anything else (available/reserved/active) → live: `active` when the row is
 *   linked to inventory or was already active, else `pending_link`.
 */
function nextRowStatus(listingStatus: string, prev: PrevRow | null): string {
  const linked = !!prev?.inventory_item_id;
  if (listingStatus === "sold") return "sold";
  if (!prev) return "pending_link";
  if (prev.status === "sold") return linked ? "active" : "pending_link";
  if (prev.status === "active" || linked) return "active";
  return prev.status ?? "pending_link";
}

async function countLiveListings(
  service: SupabaseClient,
  userId: string,
  platform: Platform
): Promise<number> {
  const { count } = await service
    .from("platform_listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", platform)
    .in("status", ["active", "pending_link"]);
  return count ?? 0;
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
 * (`executePlatformListingsSync`, non-eBay) and the extension push endpoint —
 * one FETCHes the snapshot, the other PUSHes it.
 *
 * Match key is `(user_id, platform, external_listing_id)`. `manual_link` rows
 * (hand-curated) keep their title/image/metadata; only factual marketplace state
 * (quantity, status, url) is refreshed on them. Prune only ever removes rows of
 * the configured `source`.
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

  const prevLiveCount = await countLiveListings(service, userId, platform);

  /** DB row ids matched or created from this snapshot — everything else of this source is prune-eligible. */
  const touchedListingIds = new Set<string>();

  for (const listing of listings) {
    const { data: existing } = await service
      .from("platform_listings")
      .select("id, source, status, inventory_item_id, metadata")
      .eq("user_id", userId)
      .eq("platform", platform)
      .eq("external_listing_id", listing.externalListingId)
      .maybeSingle();

    const rowStatus = nextRowStatus(listing.status, existing ?? null);

    if (existing) {
      touchedListingIds.add(existing.id);
      const isManual = existing.source === "manual_link";
      const mergedMeta = {
        ...((existing.metadata as Record<string, unknown>) ?? {}),
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
      // Hand-curated rows: refresh factual marketplace state only, never clobber
      // the user's title/photo.
      if (!isManual) {
        update.listing_title = listing.title;
        if (listing.imageUrl) update.listing_image_url = listing.imageUrl;
        else if (source === "sync_fetch") update.listing_image_url = null;
      }
      await service.from("platform_listings").update(update).eq("id", existing.id);
    } else {
      const { data: inserted } = await service
        .from("platform_listings")
        .insert({
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
        })
        .select("id")
        .single();
      if (inserted?.id) touchedListingIds.add(inserted.id);
    }
  }

  // Prune: remove rows of this source absent from the snapshot — but only when the
  // snapshot is trustworthy (complete + non-empty + no implausible collapse).
  let pruned = 0;
  let pruneSkipped = false;
  let pruneSkippedReason: string | undefined;
  const wantsPrune = opts.prune;
  if (!wantsPrune) {
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
    touchedListingIds.size < prevLiveCount * IMPLAUSIBLE_DROP_FRACTION
  ) {
    pruneSkipped = true;
    pruneSkippedReason = "implausible_drop";
  }

  if (!pruneSkipped) {
    const { data: mirror } = await service
      .from("platform_listings")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", platform)
      .eq("source", source);
    const staleIds = (mirror ?? []).map((r) => r.id).filter((id) => !touchedListingIds.has(id));
    for (const id of staleIds) {
      await service.from("platform_listings").delete().eq("id", id);
      pruned++;
    }
  }

  const liveCount = await countLiveListings(service, userId, platform);

  await trimOldInventoryFetchSyncEvents(service, userId, eventType, nowMs);
  await service.from("sync_events").insert({
    user_id: userId,
    event_type: eventType,
    payload: {
      platform,
      listingsProcessed: listings.length,
      liveListingsInApp: liveCount,
      pruned,
      ...(pruneSkipped ? { pruneSkipped, pruneSkippedReason } : {}),
      ...(opts.eventPayloadExtra ?? {}),
    },
  });

  return {
    listingsProcessed: listings.length,
    importedOrUpdated: liveCount,
    pruned,
    pruneSkipped,
    pruneSkippedReason,
  };
}
