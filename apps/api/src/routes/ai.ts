import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";
import { getEntitlements } from "../lib/entitlements.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { PLATFORMS } from "@inv/shared";
import {
  GENERATION_PENDING_PAYLOAD_KEY,
  markAsyncDraftGenerationFailed,
  runAiDraftGenerationCore,
} from "../lib/aiGenerateDrafts.js";

const bodySchema = z.object({
  inventory_item_id: z.string().uuid(),
});

async function runAsyncDraftGenerationJob(
  env: Env,
  log: FastifyBaseLogger,
  userId: string,
  inventoryItemId: string
): Promise<void> {
  const service = createServiceSupabase(env);
  try {
    const result = await runAiDraftGenerationCore(env, service, userId, inventoryItemId);
    if (!result.ok) {
      await markAsyncDraftGenerationFailed(service, userId, inventoryItemId, result.message);
      log.error({ msg: "async_generate_drafts_failed", inventoryItemId, err: result.message });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markAsyncDraftGenerationFailed(service, userId, inventoryItemId, msg);
    log.error({ msg: "async_generate_drafts_exception", inventoryItemId, err: msg });
  }
}

export async function registerAiRoutes(app: FastifyInstance, env: Env) {
  app.post("/api/ai/generate-drafts", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const ent = await getEntitlements(auth.supabase, auth.user.id);
    if (!ent.canUseAi) {
      return reply.status(402).send({ error: "AI drafts require an active paid plan" });
    }
    if (!env.GEMINI_API_KEY) {
      return reply.status(503).send({ error: "GEMINI_API_KEY not configured" });
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const service = createServiceSupabase(env);
    const result = await runAiDraftGenerationCore(env, service, auth.user.id, parsed.data.inventory_item_id);
    if (!result.ok) {
      return reply.status(result.message === "Item not found" ? 404 : 500).send({ error: result.message });
    }
    return { ok: true, summary: result.summary, drafts: result.drafts };
  });

  app.post("/api/ai/generate-drafts-async", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const ent = await getEntitlements(auth.supabase, auth.user.id);
    if (!ent.canUseAi) {
      return reply.status(402).send({ error: "AI drafts require an active paid plan" });
    }
    if (!env.GEMINI_API_KEY) {
      return reply.status(503).send({ error: "GEMINI_API_KEY not configured" });
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const inventoryItemId = parsed.data.inventory_item_id;
    const service = createServiceSupabase(env);

    const { data: item, error: itemErr } = await service
      .from("inventory_items")
      .select("id, user_id, draft_ai_status")
      .eq("id", inventoryItemId)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (itemErr) {
      return reply.status(500).send({ error: itemErr.message });
    }
    if (!item) {
      return reply.status(404).send({ error: "Item not found" });
    }

    if (item.draft_ai_status === "pending") {
      return reply.status(202).send({ ok: true, inventory_item_id: inventoryItemId, alreadyPending: true });
    }

    const { error: upErr } = await service
      .from("inventory_items")
      .update({ draft_ai_status: "pending", updated_at: new Date().toISOString() })
      .eq("id", inventoryItemId)
      .eq("user_id", auth.user.id);
    if (upErr) {
      return reply.status(500).send({ error: upErr.message });
    }

    const { error: delErr } = await service.from("listing_drafts").delete().eq("inventory_item_id", inventoryItemId);
    if (delErr) {
      await service
        .from("inventory_items")
        .update({ draft_ai_status: null, updated_at: new Date().toISOString() })
        .eq("id", inventoryItemId)
        .eq("user_id", auth.user.id);
      return reply.status(500).send({ error: delErr.message });
    }

    const pendingPayload = { [GENERATION_PENDING_PAYLOAD_KEY]: true };
    for (const p of PLATFORMS) {
      const { error: insErr } = await service.from("listing_drafts").insert({
        user_id: auth.user.id,
        inventory_item_id: inventoryItemId,
        platform: p,
        payload: pendingPayload,
      });
      if (insErr) {
        await service
          .from("inventory_items")
          .update({ draft_ai_status: null, updated_at: new Date().toISOString() })
          .eq("id", inventoryItemId)
          .eq("user_id", auth.user.id);
        return reply.status(500).send({ error: insErr.message });
      }
    }

    reply.status(202).send({ ok: true, inventory_item_id: inventoryItemId });

    setImmediate(() => {
      void runAsyncDraftGenerationJob(env, app.log, auth.user.id, inventoryItemId);
    });
    return;
  });
}
