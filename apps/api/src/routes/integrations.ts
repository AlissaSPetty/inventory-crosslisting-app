import type { FastifyInstance } from "fastify";
import { PLATFORMS } from "@inv/shared";
import type { Env } from "../env.js";
import { decryptPayload } from "../lib/credentials.js";
import {
  createEbayWarehouseInventoryLocation,
  fetchAllEbayInventoryLocations,
  getEbayInventoryLocationStatus,
} from "../lib/ebayInventoryLocation.js";
import { getValidEbayAccessToken } from "../lib/ebayAccessToken.js";
import {
  fetchCategorySuggestions,
  fetchItemAspectsForCategory,
  fetchItemConditionPolicies,
} from "../lib/ebayCategoryApi.js";
import { requireAuth } from "../lib/httpAuth.js";
import { createServiceSupabase } from "../lib/supabase.js";

const EBAY_API = (sandbox: boolean) =>
  sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

export async function registerIntegrationRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/integrations", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const { data, error } = await auth.supabase
      .from("integration_credentials")
      .select("platform, shop_domain, updated_at");
    if (error) return reply.status(500).send({ error: error.message });

    const connections = data ?? [];
    let ebay: { inventoryLocationReady: boolean; inventoryLocationDetail?: string } | undefined;
    if (connections.some((c) => c.platform === "ebay")) {
      const service = createServiceSupabase(env);
      const { data: credRow } = await service
        .from("integration_credentials")
        .select("encrypted_payload")
        .eq("user_id", auth.user.id)
        .eq("platform", "ebay")
        .maybeSingle();
      if (credRow) {
        try {
          const creds = decryptPayload<{
            accessToken: string;
            refreshToken?: string;
            expiresAt?: number;
          }>(env, credRow.encrypted_payload);
          const st = await getEbayInventoryLocationStatus(env, creds);
          ebay = {
            inventoryLocationReady: st.ready,
            inventoryLocationDetail: st.ready ? undefined : (st.message ?? st.checkError),
          };
        } catch (e) {
          ebay = {
            inventoryLocationReady: false,
            inventoryLocationDetail: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }

    return { connections, ...(ebay ? { ebay } : {}) };
  });

  app.get("/api/integrations/ebay/policies", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const service = createServiceSupabase(env);
    const { data: credRow } = await service
      .from("integration_credentials")
      .select("encrypted_payload")
      .eq("user_id", auth.user.id)
      .eq("platform", "ebay")
      .maybeSingle();
    if (!credRow) {
      return reply.status(404).send({ error: "eBay not connected" });
    }
    const creds = decryptPayload<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    }>(env, credRow.encrypted_payload);
    const sandbox = env.EBAY_SANDBOX !== "false";
    const base = EBAY_API(sandbox);
    const fresh = await getValidEbayAccessToken(env, creds);
    const token = fresh.accessToken;
    const marketplaceId = env.EBAY_MARKETPLACE_ID;

    const fp = await fetch(
      `${base}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const pp = await fetch(
      `${base}/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const rp = await fetch(
      `${base}/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!fp.ok) return reply.status(502).send({ error: `eBay fulfillment policies: ${fp.status}` });
    if (!pp.ok) return reply.status(502).send({ error: `eBay payment policies: ${pp.status}` });
    if (!rp.ok) return reply.status(502).send({ error: `eBay return policies: ${rp.status}` });

    const fJson = (await fp.json()) as {
      fulfillmentPolicies?: { fulfillmentPolicyId: string; name?: string }[];
    };
    const pJson = (await pp.json()) as {
      paymentPolicies?: { paymentPolicyId: string; name?: string }[];
    };
    const rJson = (await rp.json()) as {
      returnPolicies?: { returnPolicyId: string; name?: string }[];
    };

    return {
      fulfillmentPolicies: (fJson.fulfillmentPolicies ?? []).map((p) => ({
        id: p.fulfillmentPolicyId,
        name: p.name ?? p.fulfillmentPolicyId,
      })),
      paymentPolicies: (pJson.paymentPolicies ?? []).map((p) => ({
        id: p.paymentPolicyId,
        name: p.name ?? p.paymentPolicyId,
      })),
      returnPolicies: (rJson.returnPolicies ?? []).map((p) => ({
        id: p.returnPolicyId,
        name: p.name ?? p.returnPolicyId,
      })),
    };
  });

  /** [getInventoryLocations](https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocations) — full list for the connected seller (paginated on the server). */
  app.get("/api/integrations/ebay/inventory-locations", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const service = createServiceSupabase(env);
    const { data: credRow } = await service
      .from("integration_credentials")
      .select("encrypted_payload")
      .eq("user_id", auth.user.id)
      .eq("platform", "ebay")
      .maybeSingle();
    if (!credRow) {
      return reply.status(404).send({ error: "eBay not connected" });
    }
    const creds = decryptPayload<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    }>(env, credRow.encrypted_payload);
    const fresh = await getValidEbayAccessToken(env, creds);
    const result = await fetchAllEbayInventoryLocations(env, creds, fresh.accessToken);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error });
    }
    return {
      ebayApiBase: result.ebayApiBase,
      sandbox: result.sandbox,
      total: result.total,
      locations: result.locations,
    };
  });

  /**
   * [createInventoryLocation](https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/createInventoryLocation)
   * — warehouse; see [Creating inventory locations](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html#creating).
   */
  app.post("/api/integrations/ebay/inventory-locations", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const service = createServiceSupabase(env);
    const { data: credRow } = await service
      .from("integration_credentials")
      .select("encrypted_payload")
      .eq("user_id", auth.user.id)
      .eq("platform", "ebay")
      .maybeSingle();
    if (!credRow) {
      return reply.status(404).send({ error: "eBay not connected" });
    }
    const creds = decryptPayload<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    }>(env, credRow.encrypted_payload);

    const b = req.body as Record<string, unknown> | undefined;
    const name = b?.name != null ? String(b.name) : "Primary warehouse";
    const merchantLocationKey = b?.merchantLocationKey != null ? String(b.merchantLocationKey) : undefined;
    const postalCode = b?.postalCode != null ? String(b.postalCode) : "";
    const country = b?.country != null ? String(b.country) : "";
    const city = b?.city != null ? String(b.city) : "";
    const stateOrProvince = b?.stateOrProvince != null ? String(b.stateOrProvince) : "";

    if (!country.trim()) {
      return reply.status(400).send({ error: "country is required (2-letter ISO code, e.g. US)." });
    }

    const fresh = await getValidEbayAccessToken(env, creds);
    const result = await createEbayWarehouseInventoryLocation(
      env,
      creds,
      {
        name,
        merchantLocationKey,
        postalCode,
        country,
        city,
        stateOrProvince,
      },
      env.EBAY_MARKETPLACE_ID,
      fresh.accessToken
    );

    if (!result.ok) {
      const isClient = result.error.includes("must be") || result.error.includes("provide");
      return reply.status(isClient ? 400 : 502).send({ error: result.error });
    }
    return { ok: true, merchantLocationKey: result.merchantLocationKey };
  });

  app.get("/api/integrations/ebay/category-suggestions", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      return reply.status(503).send({ error: "eBay OAuth not configured" });
    }
    const q = String((req.query as { q?: string }).q ?? "");
    try {
      const suggestions = await fetchCategorySuggestions(env, env.EBAY_MARKETPLACE_ID, q);
      return { suggestions };
    } catch (e) {
      return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/integrations/ebay/item-aspects", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      return reply.status(503).send({ error: "eBay OAuth not configured" });
    }
    const categoryId = String((req.query as { categoryId?: string }).categoryId ?? "").trim();
    if (!categoryId) {
      return reply.status(400).send({ error: "categoryId is required" });
    }
    try {
      const aspects = await fetchItemAspectsForCategory(env, env.EBAY_MARKETPLACE_ID, categoryId);
      return { aspects };
    } catch (e) {
      return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/integrations/ebay/item-condition-policies", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      return reply.status(503).send({ error: "eBay OAuth not configured" });
    }
    const categoryId = String((req.query as { categoryId?: string }).categoryId ?? "").trim();
    if (!categoryId) {
      return reply.status(400).send({ error: "categoryId is required" });
    }
    try {
      const conditions = await fetchItemConditionPolicies(env, env.EBAY_MARKETPLACE_ID, categoryId);
      return { conditions };
    } catch (e) {
      return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/integrations/:platform", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const platform = (req.params as { platform?: string }).platform;
    if (!platform || !PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
      return reply.status(400).send({ error: "Invalid platform" });
    }
    const { error } = await auth.supabase
      .from("integration_credentials")
      .delete()
      .eq("user_id", auth.user.id)
      .eq("platform", platform);
    if (error) return reply.status(500).send({ error: error.message });
    return { ok: true };
  });
}
