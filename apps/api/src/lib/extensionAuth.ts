import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../env.js";
import { createServiceSupabase } from "./supabase.js";
import { sha256hex } from "./crypto.js";

export type ExtensionAuthed = { userId: string; tokenId: string };

/** Skip `last_used_at` writes more often than this to avoid write amplification. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Authenticate an extension request by its opaque device token (Bearer). Resolves
 * the owning user via a service-role lookup on `sha256(token)`. Distinct from
 * `requireAuth` (Supabase JWT) — the extension never carries a Supabase session.
 */
export async function requireExtensionAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env
): Promise<ExtensionAuthed | undefined> {
  const h = request.headers.authorization;
  const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) {
    reply.status(401).send({ error: "Missing device token" });
    return undefined;
  }
  const service = createServiceSupabase(env);
  const { data: row } = await service
    .from("extension_tokens")
    .select("id, user_id, revoked_at, last_used_at")
    .eq("token_hash", sha256hex(token))
    .maybeSingle();
  if (!row || row.revoked_at) {
    reply.status(401).send({ error: "Invalid or revoked device token" });
    return undefined;
  }
  const last = row.last_used_at ? Date.parse(row.last_used_at as string) : 0;
  if (Date.now() - last > LAST_USED_THROTTLE_MS) {
    await service
      .from("extension_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  return { userId: row.user_id as string, tokenId: row.id as string };
}
