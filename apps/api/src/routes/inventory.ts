import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";

const createBody = z.object({
  title: z.string().min(1),
  sku: z.string().optional(),
  quantity_available: z.number().int().min(0).default(0),
});

const updateBody = createBody.partial();

export async function registerInventoryRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/inventory", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const { data, error } = await auth.supabase
      .from("inventory_items")
      .select("*, inventory_images(count)")
      .order("created_at", { ascending: false });
    if (error) return reply.status(500).send({ error: error.message });
    type Row = (typeof data)[number] & {
      inventory_images?: { count: number }[] | null;
    };
    const items = (data ?? []).map((row: Row) => {
      const { inventory_images: _ic, ...rest } = row;
      const photo_count =
        typeof _ic?.[0]?.count === "number" ? _ic[0].count : 0;
      return { ...rest, photo_count };
    });
    return { items };
  });

  app.post("/api/inventory", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { data, error } = await auth.supabase
      .from("inventory_items")
      .insert({
        user_id: auth.user.id,
        title: parsed.data.title,
        sku: parsed.data.sku ?? null,
        quantity_available: parsed.data.quantity_available,
      })
      .select()
      .single();
    if (error) return reply.status(500).send({ error: error.message });
    return { item: data };
  });

  app.patch("/api/inventory/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { data, error } = await auth.supabase
      .from("inventory_items")
      .update(parsed.data)
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .select()
      .single();
    if (error) return reply.status(500).send({ error: error.message });
    return { item: data };
  });

  app.delete("/api/inventory/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;

    const { data: imageRows, error: imgErr } = await auth.supabase
      .from("inventory_images")
      .select("storage_path")
      .eq("inventory_item_id", id)
      .eq("user_id", auth.user.id);
    if (imgErr) return reply.status(500).send({ error: imgErr.message });

    const paths = (imageRows ?? []).map((r) => r.storage_path).filter(Boolean);
    if (paths.length > 0) {
      const { error: stErr } = await auth.supabase.storage.from("listing-photos").remove(paths);
      if (stErr) return reply.status(500).send({ error: stErr.message });
    }

    const { error: plErr } = await auth.supabase
      .from("platform_listings")
      .delete()
      .eq("inventory_item_id", id)
      .eq("user_id", auth.user.id);
    if (plErr) return reply.status(500).send({ error: plErr.message });

    const { error } = await auth.supabase
      .from("inventory_items")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.user.id);
    if (error) return reply.status(500).send({ error: error.message });
    return reply.status(204).send();
  });
}
