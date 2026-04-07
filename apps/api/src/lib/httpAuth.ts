import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUserSupabase } from "./supabase.js";
import type { Env } from "../env.js";

export type Authed = { user: User; supabase: SupabaseClient };

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env
): Promise<Authed | undefined> {
  const h = request.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Missing bearer token" });
    return undefined;
  }
  const token = h.slice(7);
  const supabase = createUserSupabase(env, token);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    reply.status(401).send({ error: "Invalid session" });
    return undefined;
  }
  return { user: data.user, supabase };
}
