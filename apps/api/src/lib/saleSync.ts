import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "@inv/shared";
import type { Env } from "../env.js";
import { buildAdapters } from "./adapters/registry.js";
import { decryptPayload } from "./credentials.js";
import { applySaleToCanonical, quantityToApplyOnOtherListings } from "./qty.js";

export async function processWebhookIdempotent(
  service: SupabaseClient,
  source: string,
  externalId: string
): Promise<boolean> {
  const { error } = await service.from("processed_webhook_events").insert({
    source,
    external_id: externalId,
  });
  if (error) {
    if (error.code === "23505") return false;
    throw error;
  }
  return true;
}

/**
 * Handle a sale on `soldOn` for a specific marketplace listing id (e.g. eBay SKU, Shopify product GID).
 */
export async function propagateSaleQuantity(
  env: Env,
  service: SupabaseClient,
  userId: string,
  soldOn: Platform,
  externalListingId: string,
  soldQty: number
): Promise<void> {
  const { data: soldRow, error: findErr } = await service
    .from("platform_listings")
    .select("id, inventory_item_id, listed_quantity")
    .eq("user_id", userId)
    .eq("platform", soldOn)
    .eq("external_listing_id", externalListingId)
    .maybeSingle();

  if (findErr) throw findErr;
  if (!soldRow?.inventory_item_id) return;

  const { data: inv, error: invErr } = await service
    .from("inventory_items")
    .select("id, quantity_available")
    .eq("id", soldRow.inventory_item_id)
    .single();
  if (invErr) throw invErr;
  if (!inv) return;

  const { next, depleted } = applySaleToCanonical(inv.quantity_available, soldQty);
  await service
    .from("inventory_items")
    .update({
      quantity_available: next,
      status: depleted ? "sold" : "active",
      sold_at: depleted ? new Date().toISOString() : null,
    })
    .eq("id", inv.id);

  await service
    .from("platform_listings")
    .update({
      listed_quantity: Math.max(0, (soldRow.listed_quantity ?? 0) - soldQty),
      updated_at: new Date().toISOString(),
    })
    .eq("id", soldRow.id);

  const { data: others, error: oErr } = await service
    .from("platform_listings")
    .select("id, platform, external_listing_id, listed_quantity, shop_domain")
    .eq("user_id", userId)
    .eq("inventory_item_id", inv.id)
    .neq("id", soldRow.id);
  if (oErr) throw oErr;

  const adapters = buildAdapters(env);
  for (const pl of others ?? []) {
    const platform = pl.platform as Platform;
    const adapter = adapters[platform];
    const { data: credRow } = await service
      .from("integration_credentials")
      .select("encrypted_payload, shop_domain")
      .eq("user_id", userId)
      .eq("platform", platform)
      .maybeSingle();
    if (!credRow || !pl.external_listing_id) {
      await service.from("sync_events").insert({
        user_id: userId,
        inventory_item_id: inv.id,
        platform,
        event_type: "quantity_sync_skipped",
        payload: { reason: "no_credentials_or_listing_id", platformListingId: pl.id },
      });
      continue;
    }
    const creds = decryptPayload(env, credRow.encrypted_payload);
    const targetQty = quantityToApplyOnOtherListings(next, pl.listed_quantity ?? 0);
    const res = await adapter.setInventoryQuantity(creds, pl.external_listing_id, targetQty, {
      shopDomain: credRow.shop_domain ?? pl.shop_domain ?? undefined,
    });
    await service.from("sync_events").insert({
      user_id: userId,
      inventory_item_id: inv.id,
      platform,
      event_type: res.ok ? "quantity_sync_ok" : "quantity_sync_error",
      payload: { platformListingId: pl.id, result: res },
    });
    if (res.ok) {
      await service
        .from("platform_listings")
        .update({ listed_quantity: targetQty, updated_at: new Date().toISOString() })
        .eq("id", pl.id);
    }
  }
}
