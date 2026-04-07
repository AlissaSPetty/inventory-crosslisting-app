import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../env.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { propagateSaleQuantity, processWebhookIdempotent } from "../lib/saleSync.js";

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const hash = createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    const a = Buffer.from(hash, "utf8");
    const b = Buffer.from(hmacHeader, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function registerWebhookRoutes(app: FastifyInstance, env: Env) {
  app.post("/webhooks/shopify", async (req, reply) => {
      if (!env.SHOPIFY_API_SECRET) {
        return reply.status(503).send({ error: "Shopify webhook secret not configured" });
      }
      const raw = (req as { rawBody?: Buffer }).rawBody;
      if (!raw) {
        return reply.status(400).send({ error: "Missing raw body" });
      }
      const hmac = req.headers["x-shopify-hmac-sha256"] as string | undefined;
      if (!verifyShopifyHmac(raw, hmac, env.SHOPIFY_API_SECRET)) {
        return reply.status(401).send({ error: "Invalid HMAC" });
      }
      const shop = (req.headers["x-shopify-shop-domain"] as string | undefined)?.toLowerCase();
      if (!shop) {
        return reply.status(400).send({ error: "Missing shop domain" });
      }
      const topic = req.headers["x-shopify-topic"] as string | undefined;
      const body = req.body as {
        id?: number;
        line_items?: { quantity: number; product_id: number }[];
      };
      const service = createServiceSupabase(env);
      const { data: cred } = await service
        .from("integration_credentials")
        .select("user_id")
        .eq("platform", "shopify")
        .eq("shop_domain", shop)
        .maybeSingle();
      if (!cred?.user_id) {
        return reply.status(404).send({ error: "Unknown shop" });
      }
      const userId = cred.user_id;
      const eventId = `${topic}-${body.id}-${req.headers["x-shopify-event-id"] ?? ""}`;
      const ok = await processWebhookIdempotent(service, "shopify", eventId);
      if (!ok) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }
      if (topic === "orders/paid" || topic === "orders/create") {
        for (const li of body.line_items ?? []) {
          const ext = `gid://shopify/Product/${li.product_id}`;
          await propagateSaleQuantity(env, service, userId, "shopify", ext, li.quantity ?? 1);
        }
      }
      return reply.status(200).send({ ok: true });
  });

  app.post("/webhooks/ebay/:userId", async (req, reply) => {
    const userId = (req.params as { userId: string }).userId;
    const body = req.body as {
      Metadata?: { Topic?: string };
      Notification?: { Data?: { OrderLineItems?: { SKU?: string; Quantity?: number }[] } };
    };
    const service = createServiceSupabase(env);
    const topic = body.Metadata?.Topic ?? "unknown";
    const orderId = (body.Notification?.Data as { OrderID?: string } | undefined)?.OrderID ?? "evt";
    const eventId = `${topic}-${orderId}`;
    const ok = await processWebhookIdempotent(service, "ebay", eventId);
    if (!ok) {
      return reply.status(200).send({ ok: true, duplicate: true });
    }
    const items = body.Notification?.Data?.OrderLineItems ?? [];
    for (const line of items) {
      if (line.SKU) {
        await propagateSaleQuantity(env, service, userId, "ebay", line.SKU, line.Quantity ?? 1);
      }
    }
    return reply.status(200).send({ ok: true });
  });

  app.post("/webhooks/stripe", async (req, reply) => {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      return reply.status(503).send({ error: "Stripe not configured" });
    }
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      return reply.status(400).send({ error: "Missing signature" });
    }
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (!raw) {
      return reply.status(400).send({ error: "Missing raw body" });
    }
    let event: import("stripe").Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.status(400).send({ error: "Invalid signature" });
    }
    const service = createServiceSupabase(env);
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const sub = event.data.object as import("stripe").Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const { data: cust } = await service
        .from("customers")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (cust?.user_id) {
        await service
          .from("subscriptions")
          .update({
            stripe_subscription_id: sub.id,
            status: sub.status,
            plan_tier: sub.items.data[0]?.price?.nickname ?? "pro",
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", cust.user_id);
      }
    }
    return reply.status(200).send({ received: true });
  });
}


