import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { encryptPayload, parseShopifyShopDomain } from "../lib/credentials.js";

async function signOAuthState(userId: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret.slice(0, 32));
  return new SignJWT({})
    .setSubject(userId)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(key);
}

async function verifyOAuthState(state: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret.slice(0, 32));
  const { payload } = await jwtVerify(state, key, { algorithms: ["HS256"] });
  if (!payload.sub) throw new Error("Invalid state");
  return payload.sub;
}

export async function registerOAuthRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/oauth/ebay/url", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    if (!env.EBAY_CLIENT_ID || !env.EBAY_RU_NAME) {
      return reply.status(503).send({ error: "eBay OAuth not configured" });
    }
    const state = await signOAuthState(auth.user.id, env.APP_ENCRYPTION_KEY);
    const scope = encodeURIComponent(
      [
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.account",
        "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
      ].join(" ")
    );
    const ru = encodeURIComponent(env.EBAY_RU_NAME);
    const host = env.EBAY_SANDBOX === "false" ? "auth.ebay.com" : "auth.sandbox.ebay.com";
    // `prompt=login` forces eBay to show sign-in / account choice even when the browser still has an eBay session,
    // so disconnect → connect can switch accounts. See https://developer.ebay.com/api-docs/static/oauth-consent-request.html
    const url =
      `https://${host}/oauth2/authorize` +
      `?client_id=${encodeURIComponent(env.EBAY_CLIENT_ID)}` +
      `&response_type=code&redirect_uri=${ru}` +
      `&scope=${scope}` +
      `&prompt=login` +
      `&state=${encodeURIComponent(state)}`;
    return { url };
  });

  app.get("/oauth/ebay/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    if (!q.code || !q.state) {
      return reply.status(400).send({ error: "Missing code or state" });
    }
    let userId: string;
    try {
      userId = await verifyOAuthState(q.state, env.APP_ENCRYPTION_KEY);
    } catch {
      return reply.status(400).send({ error: "Invalid state" });
    }
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET || !env.EBAY_RU_NAME) {
      return reply.status(503).send({ error: "eBay not configured" });
    }
    const tokenUrl = `https://api.${env.EBAY_SANDBOX === "false" ? "" : "sandbox."}ebay.com/identity/v1/oauth2/token`;
    const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: q.code,
      redirect_uri: env.EBAY_RU_NAME,
    });
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body,
    });
    if (!res.ok) {
      return reply.status(502).send({ error: await res.text() });
    }
    const tok = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const sandbox = env.EBAY_SANDBOX !== "false";
    const identityRoot = sandbox ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";
    let ebayShopDomain = "";
    try {
      const idRes = await fetch(`${identityRoot}/commerce/identity/v1/user/`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (idRes.ok) {
        const user = (await idRes.json()) as {
          userId?: string;
          username?: string;
          accountType?: string;
          registrationMarketplaceId?: string;
        };
        ebayShopDomain = JSON.stringify({
          username: user.username ?? "",
          userId: user.userId ?? "",
          accountType: user.accountType ?? "",
          marketplace: user.registrationMarketplaceId ?? "",
        });
      }
    } catch {
      /* profile optional; connection still valid */
    }
    const payload = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
    };
    const encrypted = encryptPayload(env, payload);
    const service = createServiceSupabase(env);
    await service.from("integration_credentials").delete().eq("user_id", userId).eq("platform", "ebay");
    const { error } = await service.from("integration_credentials").insert({
      user_id: userId,
      platform: "ebay",
      encrypted_payload: encrypted,
      shop_domain: ebayShopDomain,
    });
    if (error) return reply.status(500).send({ error: error.message });
    return reply.redirect(`${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/integrations?ebay=connected`);
  });

  app.get("/api/oauth/shopify/url", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const shop = (req.query as { shop?: string }).shop;
    if (!shop || !env.SHOPIFY_API_KEY) {
      return reply.status(400).send({ error: "Missing shop or Shopify not configured" });
    }
    const domain = parseShopifyShopDomain(shop);
    const state = await signOAuthState(auth.user.id, env.APP_ENCRYPTION_KEY);
    const redirectUri = `${env.API_PUBLIC_URL.replace(/\/$/, "")}/oauth/shopify/callback`;
    const scopes = "read_products,write_products,read_inventory,write_inventory,read_orders";
    const url =
      `https://${domain}/admin/oauth/authorize` +
      `?client_id=${env.SHOPIFY_API_KEY}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;
    return { url };
  });

  app.get("/oauth/shopify/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; shop?: string };
    if (!q.code || !q.state || !q.shop) {
      return reply.status(400).send({ error: "Missing parameters" });
    }
    let userId: string;
    try {
      userId = await verifyOAuthState(q.state, env.APP_ENCRYPTION_KEY);
    } catch {
      return reply.status(400).send({ error: "Invalid state" });
    }
    if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
      return reply.status(503).send({ error: "Shopify not configured" });
    }
    const domain = parseShopifyShopDomain(q.shop);
    const service = createServiceSupabase(env);
    const body = new URLSearchParams({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code: q.code,
    });
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      return reply.status(502).send({ error: await res.text() });
    }
    const tok = (await res.json()) as { access_token: string };
    const encrypted = encryptPayload(env, {
      accessToken: tok.access_token,
      shopDomain: domain,
    });
    await service
      .from("integration_credentials")
      .delete()
      .eq("user_id", userId)
      .eq("platform", "shopify")
      .eq("shop_domain", domain);
    const { error } = await service.from("integration_credentials").insert({
      user_id: userId,
      platform: "shopify",
      encrypted_payload: encrypted,
      shop_domain: domain,
    });
    if (error) return reply.status(500).send({ error: error.message });
    return reply.redirect(`${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/integrations?shopify=connected`);
  });
}
