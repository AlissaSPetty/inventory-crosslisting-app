import type { FastifyInstance } from "fastify";
import { PLATFORMS } from "@inv/shared";
import {
  ebayShippingForApiPayload,
  normalizeEbayConditionForInventory,
  validateDraftEditor,
  type DraftEditorPayload,
} from "@inv/shared";
import { fetchItemAspectsForCategory } from "../lib/ebayCategoryApi.js";
import type { Env } from "../env.js";
import { requireAuth } from "../lib/httpAuth.js";
import { createServiceSupabase } from "../lib/supabase.js";
import { decryptPayload, encryptPayload } from "../lib/credentials.js";
import { publishToEbay } from "../lib/publishEbayListing.js";
import { publishToShopify } from "../lib/publishShopifyListing.js";
import type { Platform } from "@inv/shared";

function ebayAspectsFromListing(listing: { itemAspects?: Record<string, string> } | undefined): Record<
  string,
  string[]
> | undefined {
  const ia = listing?.itemAspects;
  if (!ia) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ia)) {
    const key = k.trim();
    const val = String(v ?? "").trim();
    if (key && val) out[key] = [val];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map known eBay Inventory JSON errors to UI hints (see Sell Inventory error catalogs). */
function ebayPublishFailureExtras(message: string): { clientField?: string; userMessage?: string } {
  if (/"errorId"\s*:\s*25020\b/.test(message)) {
    return {
      clientField: "ebay.shipping.packageWeight",
      userMessage:
        "Add a valid package weight (pounds and/or ounces) under Shipping (eBay). eBay requires package weight to publish this listing.",
    };
  }
  if (/"errorId"\s*:\s*25001\b/.test(message) || /"errorId"\s*:\s*25003\b/.test(message)) {
    return {
      userMessage:
        "eBay’s inventory service returned a temporary error while publishing. Try again in a few minutes. If it keeps failing, check Seller Hub or try later—the issue is usually on eBay’s side, not your draft.",
    };
  }
  return {};
}

function mergeListingDraftPayload(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const prevEditor = (existing.editor ?? {}) as Record<string, unknown>;
  const nextEditor = (patch.editor ?? {}) as Record<string, unknown>;
  const mergedEditor: Record<string, unknown> = { ...prevEditor, ...nextEditor };
  const deepMerge = (prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...prev };
    for (const k of Object.keys(next)) {
      const nv = next[k];
      const pv = out[k];
      if (
        nv &&
        typeof nv === "object" &&
        !Array.isArray(nv) &&
        pv &&
        typeof pv === "object" &&
        !Array.isArray(pv)
      ) {
        out[k] = deepMerge(pv as Record<string, unknown>, nv as Record<string, unknown>);
      } else {
        out[k] = nv;
      }
    }
    return out;
  };
  for (const key of ["ebay", "shopify", "depop", "poshmark", "mercari"] as const) {
    if (nextEditor[key] && typeof nextEditor[key] === "object") {
      mergedEditor[key] = deepMerge(
        typeof prevEditor[key] === "object" ? (prevEditor[key] as Record<string, unknown>) : {},
        nextEditor[key] as Record<string, unknown>
      );
    }
  }
  return {
    ...existing,
    ...patch,
    editor: mergedEditor,
  };
}

export async function registerDraftRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/listing-drafts/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const { data: anchor, error: e1 } = await auth.supabase
      .from("listing_drafts")
      .select("id, user_id, inventory_item_id, platform, payload, version, published_listing_id, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (e1) return reply.status(500).send({ error: e1.message });
    if (!anchor || anchor.user_id !== auth.user.id) {
      return reply.status(404).send({ error: "Draft not found" });
    }
    const iid = anchor.inventory_item_id as string;
    const { data: inventoryItem, error: e2 } = await auth.supabase
      .from("inventory_items")
      .select("id, title, sku, quantity_available, status, draft_ai_status")
      .eq("id", iid)
      .single();
    if (e2 || !inventoryItem) return reply.status(500).send({ error: e2?.message ?? "Inventory missing" });

    const { data: photos, error: e3 } = await auth.supabase
      .from("inventory_images")
      .select("id, storage_path, sort_order, file_updated_at")
      .eq("inventory_item_id", iid)
      .order("sort_order");
    if (e3) return reply.status(500).send({ error: e3.message });

    const { data: siblings, error: e4 } = await auth.supabase
      .from("listing_drafts")
      .select("id, platform, payload, updated_at")
      .eq("inventory_item_id", iid)
      .order("platform");
    if (e4) return reply.status(500).send({ error: e4.message });

    const { data: integrations, error: e5 } = await auth.supabase
      .from("integration_credentials")
      .select("platform, shop_domain, updated_at");
    if (e5) return reply.status(500).send({ error: e5.message });

    const ebayDraft = siblings?.find((s) => s.platform === "ebay");
    return {
      anchorDraft: anchor,
      ebayDraft: ebayDraft ?? null,
      siblings: siblings ?? [],
      inventoryItem,
      photos: photos ?? [],
      integrations: integrations ?? [],
    };
  });

  app.get("/api/listing-drafts", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const q = req.query as { inventory_item_id?: string; platform?: string };
    const iid = q.inventory_item_id;
    const platform = q.platform;
    if (platform && !PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
      return reply.status(400).send({ error: "Invalid platform" });
    }
    let query = auth.supabase
      .from("listing_drafts")
      .select(
        "id, user_id, inventory_item_id, platform, payload, version, published_listing_id, created_at, updated_at, inventory_items!inner ( title, sku, draft_ai_status, inventory_images ( id, storage_path, sort_order, file_updated_at ) )"
      )
      .eq("inventory_items.status", "active")
      .order("updated_at", { ascending: false });
    const unpublishedOnly = (req.query as { unpublished_only?: string }).unpublished_only;
    if (unpublishedOnly === "true" || unpublishedOnly === "1") {
      query = query.is("published_listing_id", null);
    }
    if (iid) {
      query = query.eq("inventory_item_id", iid);
    }
    if (platform) {
      query = query.eq("platform", platform);
    }
    const { data, error } = await query;
    if (error) return reply.status(500).send({ error: error.message });
    return { drafts: data };
  });

  app.patch("/api/listing-drafts/:id", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const body = req.body as { payload?: Record<string, unknown> };
    if (!body.payload || typeof body.payload !== "object") {
      return reply.status(400).send({ error: "Missing payload" });
    }
    const { data: anchor, error: e1 } = await auth.supabase
      .from("listing_drafts")
      .select("id, user_id, inventory_item_id, platform")
      .eq("id", id)
      .maybeSingle();
    if (e1) return reply.status(500).send({ error: e1.message });
    if (!anchor || anchor.user_id !== auth.user.id) {
      return reply.status(404).send({ error: "Draft not found" });
    }
    const iid = anchor.inventory_item_id as string;
    const { data: ebayRow, error: e2 } = await auth.supabase
      .from("listing_drafts")
      .select("id, payload")
      .eq("inventory_item_id", iid)
      .eq("platform", "ebay")
      .maybeSingle();
    if (e2) return reply.status(500).send({ error: e2.message });
    if (!ebayRow) return reply.status(404).send({ error: "eBay draft row missing for this item" });

    const existingPayload = (ebayRow.payload ?? {}) as Record<string, unknown>;
    const merged = mergeListingDraftPayload(existingPayload, body.payload);
    const { data: updated, error: e3 } = await auth.supabase
      .from("listing_drafts")
      .update({ payload: merged, updated_at: new Date().toISOString() })
      .eq("id", ebayRow.id)
      .select("id, payload, updated_at")
      .single();
    if (e3) return reply.status(500).send({ error: e3.message });
    return { ok: true, draft: updated };
  });

  app.post("/api/listing-drafts/:id/publish", async (req, reply) => {
    const auth = await requireAuth(req, reply, env);
    if (!auth) return;
    const id = (req.params as { id: string }).id;
    const body = req.body as { platforms?: string[]; payload?: Record<string, unknown> };
    const platforms = (body.platforms ?? []).filter((p): p is Platform =>
      PLATFORMS.includes(p as Platform)
    );
    if (!platforms.length) {
      return reply.status(400).send({ error: "Select at least one platform" });
    }

    const { data: anchor, error: e1 } = await auth.supabase
      .from("listing_drafts")
      .select("id, user_id, inventory_item_id")
      .eq("id", id)
      .maybeSingle();
    if (e1) return reply.status(500).send({ error: e1.message });
    if (!anchor || anchor.user_id !== auth.user.id) {
      return reply.status(404).send({ error: "Draft not found" });
    }
    const iid = anchor.inventory_item_id as string;

    const { data: ebayRow, error: e2 } = await auth.supabase
      .from("listing_drafts")
      .select("id, payload")
      .eq("inventory_item_id", iid)
      .eq("platform", "ebay")
      .maybeSingle();
    if (e2) return reply.status(500).send({ error: e2.message });
    if (!ebayRow) {
      return reply.status(404).send({ error: "eBay draft row missing for this item" });
    }

    let ebayPayload = (ebayRow.payload ?? {}) as Record<string, unknown>;
    if (body.payload && typeof body.payload === "object") {
      ebayPayload = mergeListingDraftPayload(ebayPayload, body.payload);
      const { error: saveErr } = await auth.supabase
        .from("listing_drafts")
        .update({ payload: ebayPayload, updated_at: new Date().toISOString() })
        .eq("id", ebayRow.id);
      if (saveErr) return reply.status(500).send({ error: saveErr.message });
    }

    const editor = (ebayPayload as { editor?: DraftEditorPayload }).editor;

    let ebayRequiredAspectNames: string[] | undefined;
    if (platforms.includes("ebay") && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
      const cat = editor?.ebay?.categoryId?.trim() || env.EBAY_DEFAULT_CATEGORY_ID;
      if (cat && /^\d+$/.test(cat)) {
        try {
          const aspectRows = await fetchItemAspectsForCategory(env, env.EBAY_MARKETPLACE_ID, cat);
          ebayRequiredAspectNames = aspectRows
            .filter((a) => a.aspectRequired)
            .map((a) => a.localizedAspectName);
        } catch {
          ebayRequiredAspectNames = undefined;
        }
      }
    }
    const issues = validateDraftEditor(editor, platforms, { ebayRequiredAspectNames });
    if (issues.length) {
      return reply.status(400).send({ error: "Validation failed", issues });
    }

    const { data: photos } = await auth.supabase
      .from("inventory_images")
      .select("id, storage_path, file_updated_at")
      .eq("inventory_item_id", iid)
      .order("sort_order");
    const photoIds = new Set(editor?.photoIds ?? []);
    const selectedPhotos = (photos ?? []).filter((p) => photoIds.has(p.id));
    const supabasePublicBase = `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/listing-photos`;
    const imageUrls = selectedPhotos.map((p) => {
      const encoded = p.storage_path.split("/").map((seg: string) => encodeURIComponent(seg)).join("/");
      const base = `${supabasePublicBase}/${encoded}`;
      const t = "file_updated_at" in p && typeof p.file_updated_at === "string" ? p.file_updated_at : null;
      if (t?.length) {
        const ms = Date.parse(t);
        if (!Number.isNaN(ms)) return `${base}?v=${ms}`;
      }
      return base;
    });

    const { data: inv } = await auth.supabase
      .from("inventory_items")
      .select("quantity_available")
      .eq("id", iid)
      .single();

    const service = createServiceSupabase(env);
    const results: Record<string, { ok: boolean; message?: string; url?: string; externalId?: string }> = {};

    for (const p of platforms) {
      if (p === "depop" || p === "poshmark" || p === "mercari") {
        results[p] = { ok: false, message: "Automated publishing not available" };
        continue;
      }
      if (p === "ebay") {
        const { data: credRow } = await service
          .from("integration_credentials")
          .select("encrypted_payload")
          .eq("user_id", auth.user.id)
          .eq("platform", "ebay")
          .maybeSingle();
        if (!credRow) {
          results.ebay = { ok: false, message: "eBay not connected" };
          continue;
        }
        const creds = decryptPayload<{
          accessToken: string;
          refreshToken?: string;
          expiresAt?: number;
        }>(env, credRow.encrypted_payload);
        const eb = editor?.ebay;
        if (!eb) {
          results.ebay = { ok: false, message: "Missing eBay fields" };
          continue;
        }
        const rawSku = eb.listing?.sku?.trim();
        const sanitizedSku = rawSku?.length
          ? rawSku.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 49)
          : "";
        const sku = sanitizedSku || `inv-${iid.replace(/-/g, "").slice(0, 32)}`;
        let description = eb.description!.trim();
        if (eb.listing?.color?.trim()) {
          description = `Color: ${eb.listing.color.trim()}\n\n${description}`;
        }
        const w = ebayShippingForApiPayload(eb.shipping);
        const lbs = Number(w.packageWeightLbs) || 0;
        const oz = Number(w.packageWeightOz) || 0;
        const totalLb = lbs + oz / 16;
        const len = w.packageLengthIn;
        const wid = w.packageWidthIn;
        const hgt = w.packageHeightIn;
        const hasDims =
          len != null &&
          wid != null &&
          hgt != null &&
          Number(len) > 0 &&
          Number(wid) > 0 &&
          Number(hgt) > 0;
        const packageWeightAndSize =
          totalLb > 0
            ? {
                weightPounds: totalLb,
                lengthIn: hasDims ? Number(len) : undefined,
                widthIn: hasDims ? Number(wid) : undefined,
                heightIn: hasDims ? Number(hgt) : undefined,
                shippingIrregular: w.irregularPackage === true,
              }
            : undefined;
        const pr = eb.pricing;
        const bestOffer =
          pr?.bestOfferEnabled === true
            ? {
                enabled: true as const,
                autoAcceptPrice:
                  pr.autoAcceptUsd != null && !Number.isNaN(Number(pr.autoAcceptUsd))
                    ? Number(pr.autoAcceptUsd)
                    : undefined,
                autoDeclinePrice:
                  pr.minimumOfferUsd != null && !Number.isNaN(Number(pr.minimumOfferUsd))
                    ? Number(pr.minimumOfferUsd)
                    : undefined,
              }
            : undefined;
        try {
          const out = await publishToEbay(env, creds, {
            sku,
            title: eb.title!.trim(),
            description,
            imageUrls,
            price: Number(eb.price),
            quantity: Math.min(Number(eb.quantity ?? 1), inv?.quantity_available ?? 9999),
            condition: normalizeEbayConditionForInventory(eb.condition ?? "") || "NEW",
            categoryId: eb.categoryId?.trim() || env.EBAY_DEFAULT_CATEGORY_ID,
            marketplaceId: env.EBAY_MARKETPLACE_ID,
            fulfillmentPolicyId: w.fulfillmentPolicyId,
            paymentPolicyId: w.paymentPolicyId,
            returnPolicyId: w.returnPolicyId,
            bestOffer,
            packageWeightAndSize,
            aspects: ebayAspectsFromListing(eb.listing),
          });
          const listingUrl = out.listingId
            ? env.EBAY_SANDBOX === "false"
              ? `https://www.ebay.com/itm/${out.listingId}`
              : `https://sandbox.ebay.com/itm/${out.listingId}`
            : undefined;
          const { data: ebayPl, error: ebayPlErr } = await service
            .from("platform_listings")
            .insert({
              user_id: auth.user.id,
              inventory_item_id: iid,
              platform: "ebay",
              external_listing_id: out.listingId ?? out.offerId,
              shop_domain: null,
              listing_url: listingUrl ?? null,
              listing_title: eb.title!.trim(),
              listing_image_url: imageUrls[0] ?? null,
              status: "active",
              listed_quantity: Number(eb.quantity ?? 1),
              listed_at: new Date().toISOString(),
              source: "app",
              metadata: {
                offerId: out.offerId,
                ...(eb.listing?.costOfGoods != null
                  ? { costOfGoods: eb.listing.costOfGoods }
                  : {}),
              },
            })
            .select("id")
            .single();
          if (ebayPlErr) {
            throw new Error(ebayPlErr.message);
          }
          if (ebayPl?.id) {
            await service
              .from("listing_drafts")
              .update({ published_listing_id: ebayPl.id, updated_at: new Date().toISOString() })
              .eq("user_id", auth.user.id)
              .eq("inventory_item_id", iid)
              .eq("platform", "ebay");
          }
          results.ebay = { ok: true, url: listingUrl, externalId: out.listingId ?? out.offerId };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          req.log.warn({ err }, `eBay publish failed: ${message}`);
          const extras = ebayPublishFailureExtras(message);
          results.ebay = { ok: false, message, ...extras };
        }
        continue;
      }
      if (p === "shopify") {
        const { data: credRow } = await service
          .from("integration_credentials")
          .select("encrypted_payload, shop_domain")
          .eq("user_id", auth.user.id)
          .eq("platform", "shopify")
          .maybeSingle();
        if (!credRow?.shop_domain) {
          results.shopify = { ok: false, message: "Shopify not connected" };
          continue;
        }
        const creds = decryptPayload<{ accessToken: string; shopDomain?: string }>(
          env,
          credRow.encrypted_payload
        );
        const sh = editor?.shopify;
        if (!sh) {
          results.shopify = { ok: false, message: "Missing Shopify fields" };
          continue;
        }
        try {
          const out = await publishToShopify(
            { accessToken: creds.accessToken, shopDomain: credRow.shop_domain },
            {
              title: sh.title!.trim(),
              bodyHtml: (sh.bodyHtml ?? "").trim() || `<p>${(sh.title ?? "").trim()}</p>`,
              price: Number(sh.price),
              quantity: Math.min(Number(sh.quantity ?? 1), inv?.quantity_available ?? 9999),
            }
          );
          const { data: shopPl, error: shopPlErr } = await service
            .from("platform_listings")
            .insert({
              user_id: auth.user.id,
              inventory_item_id: iid,
              platform: "shopify",
              external_listing_id: out.productId,
              shop_domain: credRow.shop_domain,
              listing_url: out.adminUrl,
              listing_title: sh.title!.trim(),
              listing_image_url: null,
              status: "active",
              listed_quantity: Number(sh.quantity ?? 1),
              listed_at: new Date().toISOString(),
              source: "app",
              metadata: {},
            })
            .select("id")
            .single();
          if (shopPlErr) {
            throw new Error(shopPlErr.message);
          }
          if (shopPl?.id) {
            await service
              .from("listing_drafts")
              .update({ published_listing_id: shopPl.id, updated_at: new Date().toISOString() })
              .eq("user_id", auth.user.id)
              .eq("inventory_item_id", iid)
              .eq("platform", "shopify");
          }
          results.shopify = { ok: true, url: out.adminUrl, externalId: out.productId };
        } catch (err) {
          results.shopify = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    const failed = Object.entries(results).filter(([, v]) => !v.ok);
    if (failed.length === Object.keys(results).length && Object.keys(results).length > 0) {
      return reply.status(502).send({ error: "Publish failed for all platforms", results });
    }
    return { ok: true, results };
  });
}
