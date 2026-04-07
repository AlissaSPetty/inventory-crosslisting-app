import type { Env } from "../env.js";
import { createServiceSupabase } from "../lib/supabase.js";

/**
 * MVP: marks eBay listings past relist_at and records sync_events.
 * Full withdraw/republish can call eBay Inventory APIs in a follow-up.
 */
export function startEbayRelistScheduler(env: Env): NodeJS.Timeout {
  return setInterval(async () => {
    const service = createServiceSupabase(env);
    const { data: due } = await service
      .from("platform_listings")
      .select("id, user_id, external_listing_id")
      .eq("platform", "ebay")
      .lte("relist_at", new Date().toISOString())
      .not("relist_at", "is", null)
      .limit(50);
    for (const row of due ?? []) {
      await service.from("sync_events").insert({
        user_id: row.user_id,
        event_type: "relist_due",
        payload: { platformListingId: row.id, sku: row.external_listing_id },
      });
      await service
        .from("platform_listings")
        .update({
          relist_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", row.id);
    }
  }, 60 * 60 * 1000);
}
