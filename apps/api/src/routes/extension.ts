import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ExtensionSnapshotSchema } from "@inv/shared";
import type { Env } from "../env.js";
import type { NormalizedListing } from "../lib/adapters/types.js";
import { requireAuth } from "../lib/httpAuth.js";
import { requireExtensionAuth } from "../lib/extensionAuth.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { ingestListingSnapshot } from "../lib/ingestSnapshot.js";
import { encryptPayload } from "../lib/credentials.js";
import { pairingCodeHash, randomToken, sha256hex } from "../lib/crypto.js";

const pairBody = z.object({ code: z.string().min(1), label: z.string().max(120).optional() });

/** Best-effort in-memory per-IP limiter for the unauthenticated `/pair` endpoint. */
const pairAttempts = new Map<string, { count: number; resetAt: number }>();
function pairRateLimited(ip: string): boolean {
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const MAX = 10;
  const rec = pairAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    pairAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX;
}

/** One stable `integration_credentials` row per (user, poshmark) so Integrations shows "Connected". */
async function upsertPoshmarkMarker(
  service: SupabaseClient,
  env: Env,
  userId: string,
  username: string | null
): Promise<void> {
  const encrypted_payload = encryptPayload(env, {
    connectedVia: "extension",
    ...(username ? { username } : {}),
  });
  const { data: existing } = await service
    .from("integration_credentials")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", "poshmark")
    .maybeSingle();
  if (existing) {
    await service
      .from("integration_credentials")
      .update({ encrypted_payload, ...(username ? { shop_domain: username } : {}) })
      .eq("id", existing.id);
  } else {
    await service.from("integration_credentials").insert({
      user_id: userId,
      platform: "poshmark",
      encrypted_payload,
      shop_domain: username ?? null,
    });
  }
}

export async function registerExtensionRoutes(app: FastifyInstance, env: Env) {
  // Exchange a short-lived pairing code (minted by the web app) for a device token.
  app.post("/api/extension/pair", async (req, reply) => {
    if (pairRateLimited(req.ip)) {
      return reply.status(429).send({ error: "Too many attempts, try again shortly" });
    }
    const parsed = pairBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Missing code" });

    const service = createServiceSupabase(env);
    const { data: codeRow } = await service
      .from("extension_pairing_codes")
      .select("id, user_id, expires_at, used_at")
      .eq("code_hash", pairingCodeHash(parsed.data.code))
      .maybeSingle();
    if (!codeRow || codeRow.used_at || Date.parse(codeRow.expires_at as string) < Date.now()) {
      return reply.status(400).send({ error: "Invalid or expired pairing code" });
    }
    // Single-use: burn the code before issuing the token.
    await service
      .from("extension_pairing_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", codeRow.id);

    const token = randomToken(32);
    const ua = req.headers["user-agent"];
    const { error: insErr } = await service.from("extension_tokens").insert({
      user_id: codeRow.user_id,
      token_hash: sha256hex(token),
      label: parsed.data.label ?? null,
      user_agent: typeof ua === "string" ? ua.slice(0, 300) : null,
    });
    if (insErr) return reply.status(500).send({ error: insErr.message });
    return { ok: true, token };
  });

  // Device-authed: ingest a Poshmark closet snapshot pushed by the extension.
  app.post("/api/extension/poshmark/listings", async (req, reply) => {
    const auth = await requireExtensionAuth(req, reply, env);
    if (!auth) return;
    const parsed = ExtensionSnapshotSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const snap = parsed.data;
    if (snap.platform !== "poshmark") {
      return reply.status(400).send({ error: "Expected platform 'poshmark'" });
    }

    const service = createServiceSupabase(env);
    const listings: NormalizedListing[] = snap.listings.map((l) => ({
      externalListingId: l.externalListingId,
      title: l.title,
      priceCents: l.priceCents,
      quantity: l.quantity,
      status: l.status,
      url: l.url,
      imageUrl: l.imageUrl,
      listedAt: l.listedAt,
      metadata: {
        ...(l.metadata ?? {}),
        origin: "extension",
        ...(l.priceCents != null ? { priceCents: l.priceCents } : {}),
        ...(snap.username ? { poshmark_username: snap.username } : {}),
      },
    }));

    const result = await ingestListingSnapshot(service, auth.userId, "poshmark", listings, {
      shopDomain: snap.username ?? null,
      prune: true,
      complete: snap.complete,
      source: "sync_fetch",
      eventPayloadExtra: { origin: "extension", username: snap.username ?? null },
    });

    await upsertPoshmarkMarker(service, env, auth.userId, snap.username ?? null);
    return { ok: true, ...result };
  });

  // Device-authed: lightweight connection check for the extension popup.
  app.get("/api/extension/status", async (req, reply) => {
    const auth = await requireExtensionAuth(req, reply, env);
    if (!auth) return;
    const service = createServiceSupabase(env);
    const { data: marker } = await service
      .from("integration_credentials")
      .select("shop_domain, updated_at")
      .eq("user_id", auth.userId)
      .eq("platform", "poshmark")
      .maybeSingle();
    return {
      ok: true,
      poshmark: marker
        ? { username: marker.shop_domain ?? null, connectedAt: marker.updated_at }
        : null,
    };
  });

  // Web-authed: list / revoke paired devices. Owner-scoped via RLS; never selects token_hash.
  app.get("/api/extension/devices", async (req, reply) => {
    const authed = await requireAuth(req, reply, env);
    if (!authed) return;
    const { data, error } = await authed.supabase
      .from("extension_tokens")
      .select("id, label, user_agent, created_at, last_used_at, revoked_at")
      .order("created_at", { ascending: false });
    if (error) return reply.status(500).send({ error: error.message });
    return { devices: data ?? [] };
  });

  app.delete("/api/extension/devices/:id", async (req, reply) => {
    const authed = await requireAuth(req, reply, env);
    if (!authed) return;
    const id = (req.params as { id: string }).id;
    const { data, error } = await authed.supabase
      .from("extension_tokens")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: "Device not found" });
    return { ok: true };
  });
}
