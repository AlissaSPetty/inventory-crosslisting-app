import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";
import { PLATFORMS, type Platform } from "@inv/shared";

const platformEnum = z.enum(["ebay", "shopify", "depop", "poshmark", "mercari"]);

const listingBody = z.object({
  inventory_item_id: z.string().uuid(),
  platform: platformEnum,
  external_listing_id: z.string().optional(),
  shop_domain: z.string().optional(),
  listing_url: z.string().optional(),
  listed_quantity: z.number().int().min(0).default(1),
  metadata: z.record(z.unknown()).optional(),
  source: z.enum(["app", "sync_fetch", "manual_link"]).default("app"),
});

export async function registerPlatformRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/platform-listings", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const q = req.query as { status?: string; platform?: string };
    let query = auth.supabase
      .from("platform_listings")
      .select(
        "*, inventory_items ( id, title, sku, inventory_images ( id, storage_path, sort_order, file_updated_at ) )"
      )
      .order("listed_at", { ascending: false });
    if (q.status?.trim()) {
      const s = q.status.trim();
      /** Live on a marketplace: published from the app (`active`) or pulled by sync before inventory link (`pending_link`). */
      if (s === "live") {
        query = query.in("status", ["active", "pending_link"]);
      } else {
        query = query.eq("status", s);
      }
    }
    if (q.platform?.trim() && PLATFORMS.includes(q.platform as Platform)) {
      query = query.eq("platform", q.platform.trim());
    }
    const { data, error } = await query;
    if (error) return reply.status(500).send({ error: error.message });
    return { listings: data };
  });

  app.post("/api/platform-listings", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const parsed = listingBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { data, error } = await auth.supabase
      .from("platform_listings")
      .insert({
        user_id: auth.user.id,
        inventory_item_id: parsed.data.inventory_item_id,
        platform: parsed.data.platform as Platform,
        external_listing_id: parsed.data.external_listing_id ?? null,
        shop_domain: parsed.data.shop_domain ?? null,
        listing_url: parsed.data.listing_url ?? null,
        listed_quantity: parsed.data.listed_quantity,
        metadata: parsed.data.metadata ?? {},
        source: parsed.data.source,
        status: "active",
        listed_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return reply.status(500).send({ error: error.message });
    return { listing: data };
  });
}
