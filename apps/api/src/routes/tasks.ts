import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";

/**
 * User-facing sync tasks derived from `sync_events`. Primary use: `manual_action_required`
 * to-dos for hybrid (Poshmark/Mercari) listings when a sale elsewhere depletes shared inventory.
 * "Open" = `acknowledged_at is null`.
 */
export async function registerTaskRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/sync-events", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const q = req.query as { type?: string; open?: string };
    let query = auth.supabase
      .from("sync_events")
      .select("id, platform, inventory_item_id, payload, created_at, acknowledged_at")
      .order("created_at", { ascending: false });
    if (q.type?.trim()) query = query.eq("event_type", q.type.trim());
    if (q.open === "true" || q.open === "1") query = query.is("acknowledged_at", null);
    const { data, error } = await query;
    if (error) return reply.status(500).send({ error: error.message });
    const tasks = (data ?? []).map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        platform: e.platform,
        inventory_item_id: e.inventory_item_id,
        listing_url: typeof p.listing_url === "string" ? p.listing_url : null,
        targetQty: typeof p.targetQty === "number" ? p.targetQty : null,
        created_at: e.created_at,
        acknowledged_at: e.acknowledged_at,
      };
    });
    return { tasks };
  });

  app.post("/api/sync-events/:id/ack", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const { data, error } = await auth.supabase
      .from("sync_events")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .select("id")
      .maybeSingle();
    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: "Task not found" });
    return { ok: true };
  });
}
