import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";

/**
 * Phase 2 (Nifty parity) endpoints are placeholders — expand per roadmap:
 * teams/orgs, deep import runs, AI dedupe, analytics, Etsy, non-eBay relist.
 */
export async function registerPhase2Routes(app: FastifyInstance, env: Env) {
  app.get("/api/phase2/status", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    return {
      phase: 2,
      items: {
        teams: "planned",
        deepImport: "planned",
        aiDedupe: "planned",
        analytics: "planned",
        etsy: "optional",
        extendedRelist: "planned",
      },
    };
  });
}
