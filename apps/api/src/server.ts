import "./loadEnvFiles.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import { loadEnv } from "./env.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerPlatformRoutes } from "./routes/platforms.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerPhase2Routes } from "./routes/phase2.js";
import { startEbayRelistScheduler } from "./jobs/ebayRelist.js";

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      try {
        const buf = body as Buffer;
        (req as { rawBody?: Buffer }).rawBody = buf;
        if (!buf || buf.length === 0) {
          done(null, {});
          return;
        }
        const json = JSON.parse(buf.toString("utf8"));
        done(null, json);
      } catch (err) {
        done(err as Error);
      }
    }
  );

  await app.register(cors, {
    origin: env.PUBLIC_WEB_URL,
    credentials: true,
  });
  await app.register(formbody);

  await registerInventoryRoutes(app, env);
  await registerPlatformRoutes(app, env);
  await registerOAuthRoutes(app, env);
  await registerWebhookRoutes(app, env);
  await registerSyncRoutes(app, env);
  await registerAiRoutes(app, env);
  await registerIntegrationRoutes(app, env);
  await registerDraftRoutes(app, env);
  await registerPhase2Routes(app, env);

  app.get("/health", async () => ({ ok: true }));

  startEbayRelistScheduler(env);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
