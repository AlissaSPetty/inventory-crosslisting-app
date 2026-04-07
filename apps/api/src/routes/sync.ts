import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { buildAdapters } from "../lib/adapters/registry.js";
import { decryptPayload, encryptPayload } from "../lib/credentials.js";
import { getValidEbayAccessToken, refreshEbayAccessToken } from "../lib/ebayAccessToken.js";
import type { NormalizedListing } from "../lib/adapters/types.js";
import { PLATFORMS, type Platform } from "@inv/shared";

const platformEnum = z.enum(["ebay", "shopify", "depop", "poshmark", "mercari"]);

function isPlatform(p: string): p is Platform {
  return (PLATFORMS as readonly string[]).includes(p);
}

type EbayUserCreds = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

function ebayCredsEqual(a: EbayUserCreds, b: EbayUserCreds): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt
  );
}

async function persistEbayCredentials(
  service: SupabaseClient,
  env: Env,
  userId: string,
  creds: EbayUserCreds
): Promise<void> {
  const { error } = await service
    .from("integration_credentials")
    .update({
      encrypted_payload: encryptPayload(env, {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      }),
    })
    .eq("user_id", userId)
    .eq("platform", "ebay");
  if (error) throw new Error(error.message);
}

/**
 * App-published rows use `external_listing_id` = eBay listing id; Inventory sync uses SKU.
 * Match the same live listing so we update one row instead of inserting a duplicate.
 */
async function findExistingEbayPlatformListing(
  service: SupabaseClient,
  userId: string,
  listing: NormalizedListing
): Promise<{ id: string } | null> {
  const { data: byExt } = await service
    .from("platform_listings")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .eq("external_listing_id", listing.externalListingId)
    .maybeSingle();
  if (byExt) return byExt;

  const meta = listing.metadata as { ebayListingId?: string; sku?: string } | undefined;
  const itemIdFromUrl = listing.url?.match(/\/itm\/(\d+)/)?.[1];
  const ebayListingId = meta?.ebayListingId ?? itemIdFromUrl;

  if (ebayListingId) {
    const { data: byItemId } = await service
      .from("platform_listings")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", "ebay")
      .eq("external_listing_id", ebayListingId)
      .maybeSingle();
    if (byItemId) return byItemId;

    const { data: byUrl } = await service
      .from("platform_listings")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", "ebay")
      .ilike("listing_url", `%/itm/${ebayListingId}%`)
      .maybeSingle();
    if (byUrl) return byUrl;
  }

  const sku = meta?.sku;
  if (sku) {
    const { data: bySku } = await service
      .from("platform_listings")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", "ebay")
      .eq("external_listing_id", sku)
      .maybeSingle();
    if (bySku) return bySku;
  }

  return null;
}

/** Drop routine sync audit rows so per-user `sync_events` does not grow without bound. */
const INVENTORY_FETCH_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Remove `platform_listings` that are absent from the latest marketplace snapshot.
 *
 * - **`sync_fetch`**: Rows we only mirror from the platform API — if not returned this run, delete
 *   regardless of `status` (ended, duplicate, or stale mirror data).
 * - **`app`**: Published-from-app rows — only prune when still marked live (`active` / `pending_link`)
 *   but no longer returned as active (listing ended/delisted off-platform).
 * - **`manual_link`**: Never removed here (not API-authoritative).
 */
async function prunePlatformListingsAfterFetch(
  service: SupabaseClient,
  userId: string,
  platform: Platform,
  touchedListingIds: Set<string>
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: appLive, error: e1 } = await service
    .from("platform_listings")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", platform)
    .eq("source", "app")
    .in("status", ["active", "pending_link"]);
  if (e1) return { ok: false, message: e1.message };

  const { data: syncMirror, error: e2 } = await service
    .from("platform_listings")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", platform)
    .eq("source", "sync_fetch");
  if (e2) return { ok: false, message: e2.message };

  const staleIds = new Set<string>();
  for (const r of appLive ?? []) {
    if (!touchedListingIds.has(r.id)) staleIds.add(r.id);
  }
  for (const r of syncMirror ?? []) {
    if (!touchedListingIds.has(r.id)) staleIds.add(r.id);
  }

  for (const id of staleIds) {
    const { error: delErr } = await service.from("platform_listings").delete().eq("id", id);
    if (delErr) return { ok: false, message: delErr.message };
  }
  return { ok: true };
}

async function trimOldInventoryFetchSyncEvents(service: SupabaseClient, userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - INVENTORY_FETCH_EVENT_RETENTION_MS).toISOString();
  await service
    .from("sync_events")
    .delete()
    .eq("user_id", userId)
    .eq("event_type", "inventory_fetch_completed")
    .lt("created_at", cutoff);
}

type SyncListingsResult =
  | { status: "synced"; importedOrUpdated: number }
  | { status: "failed"; message: string; code?: string };

async function executePlatformListingsSync(
  env: Env,
  userId: string,
  platform: Platform
): Promise<SyncListingsResult> {
  const adapters = buildAdapters(env);
  const adapter = adapters[platform];
  const service = createServiceSupabase(env);
  const { data: credRow } = await service
    .from("integration_credentials")
    .select("encrypted_payload, shop_domain")
    .eq("user_id", userId)
    .eq("platform", platform)
    .maybeSingle();
  if (!credRow) {
    return { status: "failed", message: "No credentials for platform", code: "no_credentials" };
  }
  const creds = decryptPayload(env, credRow.encrypted_payload);
  let adapterCreds: unknown = creds;
  /** One forced refresh + retry when eBay returns 401 (e.g. token revoked though `expiresAt` still valid). */
  let ebay401Retried = false;

  if (platform === "ebay") {
    const ebayParsed = creds as EbayUserCreds;
    try {
      const fresh = await getValidEbayAccessToken(env, ebayParsed);
      if (!ebayCredsEqual(ebayParsed, fresh)) {
        await persistEbayCredentials(service, env, userId, fresh);
      }
      adapterCreds = fresh;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "failed", message: msg, code: "ebay_auth" };
    }
  }

  let cursor: string | undefined;
  let total = 0;
  /** DB row ids matched or created from this pull — everything else mirror-sourced is eligible for prune. */
  const touchedListingIds = new Set<string>();
  do {
    let res = await adapter.fetchActiveListings(adapterCreds, cursor);
    if (
      !res.ok &&
      platform === "ebay" &&
      /\b401\b/.test(res.message) &&
      !ebay401Retried
    ) {
      ebay401Retried = true;
      try {
        const rotated = await refreshEbayAccessToken(env, adapterCreds as EbayUserCreds);
        await persistEbayCredentials(service, env, userId, rotated);
        adapterCreds = rotated;
        res = await adapter.fetchActiveListings(adapterCreds, cursor);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "failed", message: msg, code: "ebay_auth" };
      }
    }
    if (!res.ok) {
      return { status: "failed", message: res.message, code: res.code };
    }
    for (const listing of res.data.listings) {
      let existing: { id: string; source?: string } | null = null;
      if (platform === "ebay") {
        existing = await findExistingEbayPlatformListing(service, userId, listing);
      } else {
        const { data } = await service
          .from("platform_listings")
          .select("id, source")
          .eq("user_id", userId)
          .eq("platform", platform)
          .eq("external_listing_id", listing.externalListingId)
          .maybeSingle();
        existing = data;
      }
      if (existing) {
        touchedListingIds.add(existing.id);
        if (platform === "ebay") {
          const { data: prevRow } = await service
            .from("platform_listings")
            .select("metadata, status, inventory_item_id, source")
            .eq("id", existing.id)
            .maybeSingle();
          const mergedMeta = {
            ...((prevRow?.metadata as Record<string, unknown>) ?? {}),
            ...((listing.metadata as Record<string, unknown>) ?? {}),
          };
          const syncMirror = prevRow?.source === "sync_fetch";
          const ebayUpdate: Record<string, unknown> = {
            listed_quantity: listing.quantity,
            listing_title: listing.title,
            /** Mirror rows: always align with API (clear when no image). App/manual rows: omit when absent so Trading merge does not wipe photos. */
            ...(syncMirror
              ? { listing_image_url: listing.imageUrl ?? null }
              : listing.imageUrl
                ? { listing_image_url: listing.imageUrl }
                : {}),
            ...(listing.url ? { listing_url: listing.url } : {}),
            ...(listing.listedAt ? { listed_at: listing.listedAt } : {}),
            metadata: mergedMeta,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (prevRow?.status === "active" || prevRow?.inventory_item_id) {
            ebayUpdate.status = "active";
          }
          await service.from("platform_listings").update(ebayUpdate).eq("id", existing.id);
        } else {
          const syncMirror = existing.source === "sync_fetch";
          await service
            .from("platform_listings")
            .update({
              listed_quantity: listing.quantity,
              listing_title: listing.title,
              ...(syncMirror
                ? { listing_image_url: listing.imageUrl ?? null }
                : listing.imageUrl
                  ? { listing_image_url: listing.imageUrl }
                  : {}),
              ...(listing.url ? { listing_url: listing.url } : {}),
              ...(listing.listedAt ? { listed_at: listing.listedAt } : {}),
              metadata: listing.metadata ?? {},
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
        }
      } else {
        const { data: inserted, error: insErr } = await service
          .from("platform_listings")
          .insert({
            user_id: userId,
            inventory_item_id: null,
            platform,
            external_listing_id: listing.externalListingId,
            shop_domain: credRow.shop_domain || null,
            listing_url: listing.url ?? null,
            listing_title: listing.title,
            listing_image_url: listing.imageUrl ?? null,
            listed_at: listing.listedAt ?? new Date().toISOString(),
            status: "pending_link",
            listed_quantity: listing.quantity,
            source: "sync_fetch",
            metadata: listing.metadata ?? {},
            last_synced_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (insErr) {
          return { status: "failed", message: insErr.message };
        }
        if (inserted?.id) touchedListingIds.add(inserted.id);
      }
      total++;
    }
    cursor = res.data.nextCursor;
  } while (cursor);

  const pruneRes = await prunePlatformListingsAfterFetch(service, userId, platform, touchedListingIds);
  if (!pruneRes.ok) {
    return { status: "failed", message: pruneRes.message };
  }

  await trimOldInventoryFetchSyncEvents(service, userId);

  await service.from("sync_events").insert({
    user_id: userId,
    event_type: "inventory_fetch_completed",
    payload: { platform, count: total },
  });
  return { status: "synced", importedOrUpdated: total };
}

export async function registerSyncRoutes(app: FastifyInstance, env: Env) {
  app.post("/api/sync/all", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const service = createServiceSupabase(env);
    const { data: connections, error } = await service
      .from("integration_credentials")
      .select("platform")
      .eq("user_id", auth.user.id);
    if (error) return reply.status(500).send({ error: error.message });
    const platforms = [
      ...new Set((connections ?? []).map((c) => c.platform).filter(isPlatform)),
    ];
    const results: Array<{
      platform: string;
      status: "ok" | "skipped";
      importedOrUpdated?: number;
      message?: string;
      code?: string;
    }> = [];
    for (const platform of platforms) {
      const result = await executePlatformListingsSync(env, auth.user.id, platform);
      if (result.status === "synced") {
        results.push({ platform, status: "ok", importedOrUpdated: result.importedOrUpdated });
      } else {
        results.push({
          platform,
          status: "skipped",
          message: result.message,
          code: result.code,
        });
      }
    }
    return { ok: true, platforms: results };
  });

  app.post("/api/sync/:platform", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const platform = platformEnum.parse((req.params as { platform: string }).platform) as Platform;
    const result = await executePlatformListingsSync(env, auth.user.id, platform);
    if (result.status === "failed") {
      if (result.code === "no_credentials") {
        return reply.status(400).send({ error: result.message });
      }
      return reply.status(502).send({ error: result.message, code: result.code });
    }
    return { ok: true, importedOrUpdated: result.importedOrUpdated };
  });
}
