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

/** Edits to a manual (`source='manual_link'`) row only — never app/sync_fetch rows. */
const listingPatchBody = z.object({
  listing_url: z.string().optional(),
  external_listing_id: z.string().nullable().optional(),
  listed_quantity: z.number().int().min(0).optional(),
  status: z.enum(["active", "ended"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  listing_title: z.string().optional(),
  listing_image_url: z.string().optional(),
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

  app.patch("/api/platform-listings/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const parsed = listingPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    updates.updated_at = new Date().toISOString();
    const { data, error } = await auth.supabase
      .from("platform_listings")
      .update(updates)
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .eq("source", "manual_link")
      .select()
      .maybeSingle();
    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: "Manual listing not found" });
    return { listing: data };
  });

  app.delete("/api/platform-listings/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    // FK `listing_drafts.published_listing_id → platform_listings(id) ON DELETE SET NULL`
    // re-surfaces the linked draft under /hybrid after removal.
    const { data, error } = await auth.supabase
      .from("platform_listings")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .eq("source", "manual_link")
      .select("id")
      .maybeSingle();
    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: "Manual listing not found" });
    return { ok: true };
  });
}
