import type { Env } from "../env.js";
import { fetchCategoryLeafStatus, fetchItemAspectsForCategory } from "./ebayCategoryApi.js";
import { getEbayInventoryLocationStatus } from "./ebayInventoryLocation.js";
import { getValidEbayAccessToken } from "./ebayAccessToken.js";
import { localeForEbayMarketplace } from "./ebayLocale.js";

const EBAY_API = (sandbox: boolean) =>
  sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

/** eBay error 25002 includes `offerId` in parameters when createOffer races an existing offer. */
function tryParseOfferIdFromDuplicateError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      errors?: { errorId?: number; parameters?: { name?: string; value?: string }[] }[];
    };
    const err = parsed.errors?.find((e) => e.errorId === 25002);
    const param = err?.parameters?.find((p) => p.name === "offerId");
    return param?.value?.trim() || null;
  } catch {
    return null;
  }
}

export type PublishEbayInput = {
  sku: string;
  title: string;
  description: string;
  imageUrls: string[];
  price: number;
  quantity: number;
  condition: string;
  categoryId: string;
  marketplaceId: string;
  fulfillmentPolicyId?: string | null;
  paymentPolicyId?: string | null;
  returnPolicyId?: string | null;
  bestOffer?: {
    enabled: boolean;
    autoAcceptPrice?: number;
    autoDeclinePrice?: number;
  };
  packageWeightAndSize?: {
    weightPounds: number;
    lengthIn?: number;
    widthIn?: number;
    heightIn?: number;
    shippingIrregular?: boolean;
  };
  /** Item specifics (localized aspect name → one or more values). */
  aspects?: Record<string, string[]>;
};

export async function publishToEbay(
  env: Env,
  creds: { accessToken: string; refreshToken?: string; expiresAt?: number },
  input: PublishEbayInput
): Promise<{ offerId: string; listingId?: string }> {
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_API(sandbox);
  const fresh = await getValidEbayAccessToken(env, creds);
  const token = fresh.accessToken;
  const locale = localeForEbayMarketplace(input.marketplaceId);
  const commonHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Accept-Language": locale,
  };
  const jsonWriteHeaders: Record<string, string> = {
    ...commonHeaders,
    "Content-Type": "application/json",
    "Content-Language": locale,
  };

  const catId = input.categoryId.trim();
  if (!catId) {
    throw new Error("eBay category ID is required.");
  }
  const leaf = await fetchCategoryLeafStatus(env, input.marketplaceId, catId);
  if (!leaf.leaf) {
    const hint = leaf.categoryName ? ` (${leaf.categoryName})` : "";
    throw new Error(
      `eBay requires a leaf category (most specific; no subcategories). Category ${catId}${hint} is not a leaf — use category search in the draft editor or set EBAY_DEFAULT_CATEGORY_ID to a leaf category ID.`
    );
  }

  const aspectMeta = await fetchItemAspectsForCategory(env, input.marketplaceId, catId);
  const provided = input.aspects ?? {};
  const missing: string[] = [];
  for (const a of aspectMeta) {
    if (!a.aspectRequired) continue;
    const name = a.localizedAspectName;
    const vals = provided[name];
    if (!vals?.length || !vals.some((x) => String(x).trim())) missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      `eBay requires item specifics for this category: ${missing.join(", ")}. Fill them in the draft editor under Item specifics.`
    );
  }

  const fp = await fetch(
    `${base}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(input.marketplaceId)}`,
    { headers: commonHeaders }
  );
  const pp = await fetch(
    `${base}/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(input.marketplaceId)}`,
    { headers: commonHeaders }
  );
  const rp = await fetch(
    `${base}/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(input.marketplaceId)}`,
    { headers: commonHeaders }
  );
  if (!fp.ok) throw new Error(`eBay fulfillment policies: ${fp.status} ${await fp.text()}`);
  if (!pp.ok) throw new Error(`eBay payment policies: ${pp.status} ${await pp.text()}`);
  if (!rp.ok) throw new Error(`eBay return policies: ${rp.status} ${await rp.text()}`);

  const fJson = (await fp.json()) as { fulfillmentPolicies?: { fulfillmentPolicyId: string; name?: string }[] };
  const pJson = (await pp.json()) as { paymentPolicies?: { paymentPolicyId: string; name?: string }[] };
  const rJson = (await rp.json()) as { returnPolicies?: { returnPolicyId: string; name?: string }[] };

  const fulfillmentPolicyId =
    input.fulfillmentPolicyId?.trim() ||
    fJson.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
  const paymentPolicyId =
    input.paymentPolicyId?.trim() || pJson.paymentPolicies?.[0]?.paymentPolicyId;
  const returnPolicyId =
    input.returnPolicyId?.trim() || rJson.returnPolicies?.[0]?.returnPolicyId;
  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    throw new Error(
      "eBay account needs fulfillment, payment, and return policies for this marketplace (create them in Seller Hub)."
    );
  }

  const locStatus = await getEbayInventoryLocationStatus(env, creds, token);
  if (!locStatus.ready) {
    throw new Error(locStatus.message ?? locStatus.checkError ?? "No eBay inventory location");
  }
  const merchantLocationKey = locStatus.merchantLocationKey!;

  const product: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    imageUrls: input.imageUrls.slice(0, 12),
  };

  if (input.aspects && Object.keys(input.aspects).length > 0) {
    product.aspects = input.aspects;
  }

  const pkg = input.packageWeightAndSize;
  if (pkg && pkg.weightPounds > 0) {
    const pws: Record<string, unknown> = {
      weight: {
        value: Number(pkg.weightPounds.toFixed(4)).toString(),
        unit: "POUND",
      },
    };
    if (
      pkg.lengthIn != null &&
      pkg.widthIn != null &&
      pkg.heightIn != null &&
      pkg.lengthIn > 0 &&
      pkg.widthIn > 0 &&
      pkg.heightIn > 0
    ) {
      pws.dimensions = {
        length: pkg.lengthIn,
        width: pkg.widthIn,
        height: pkg.heightIn,
        unit: "INCH",
      };
    }
    if (pkg.shippingIrregular === true) {
      pws.shippingIrregular = true;
    }
    product.packageWeightAndSize = pws;
  }

  const invBody = {
    availability: {
      shipToLocationAvailability: {
        quantity: input.quantity,
      },
    },
    condition: input.condition,
    product,
  };

  const putInv = await fetch(
    `${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`,
    {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify(invBody),
    }
  );
  if (!putInv.ok) {
    throw new Error(`eBay inventory item: ${putInv.status} ${await putInv.text()}`);
  }

  const listingPolicies: Record<string, unknown> = {
    fulfillmentPolicyId,
    paymentPolicyId,
    returnPolicyId,
  };

  const bo = input.bestOffer;
  if (bo?.enabled) {
    const terms: Record<string, unknown> = { bestOfferEnabled: true };
    if (bo.autoAcceptPrice != null && !Number.isNaN(Number(bo.autoAcceptPrice))) {
      terms.autoAcceptPrice = {
        currency: "USD",
        value: Number(bo.autoAcceptPrice).toFixed(2),
      };
    }
    if (bo.autoDeclinePrice != null && !Number.isNaN(Number(bo.autoDeclinePrice))) {
      terms.autoDeclinePrice = {
        currency: "USD",
        value: Number(bo.autoDeclinePrice).toFixed(2),
      };
    }
    listingPolicies.bestOfferTerms = terms;
  }

  const offerBody = {
    sku: input.sku,
    marketplaceId: input.marketplaceId,
    format: "FIXED_PRICE",
    listingPolicies,
    categoryId: input.categoryId,
    merchantLocationKey,
    pricingSummary: {
      price: {
        currency: "USD",
        value: String(input.price.toFixed(2)),
      },
    },
    availableQuantity: input.quantity,
  };

  const offersUrl = new URL(`${base}/sell/inventory/v1/offer`);
  offersUrl.searchParams.set("sku", input.sku);
  const listOffers = await fetch(offersUrl, { headers: commonHeaders });

  let offersJson: { offers?: { offerId: string; marketplaceId?: string }[] };
  if (listOffers.ok) {
    offersJson = (await listOffers.json()) as typeof offersJson;
  } else if (listOffers.status === 404) {
    // getOffers returns 404 + errorId 25713 ("This Offer is not available.") when the SKU has no
    // offers yet — not a fatal error; we create below. See getOffers HTTP codes in Inventory API.
    const text = await listOffers.text();
    let noOffersYet = false;
    try {
      const j = JSON.parse(text) as { errors?: { errorId?: number }[] };
      noOffersYet = j.errors?.some((e) => e.errorId === 25713) ?? false;
    } catch {
      noOffersYet = true;
    }
    if (!noOffersYet) {
      throw new Error(`eBay list offers: ${listOffers.status} ${text}`);
    }
    offersJson = { offers: [] };
  } else {
    throw new Error(`eBay list offers: ${listOffers.status} ${await listOffers.text()}`);
  }
  const existing =
    (offersJson.offers ?? []).find((o) => o.marketplaceId === input.marketplaceId) ??
    (offersJson.offers ?? [])[0];

  let offerId: string;

  if (existing?.offerId) {
    offerId = existing.offerId;
    const updateBody = { ...offerBody, offerId };
    const updateOffer = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify(updateBody),
    });
    if (!updateOffer.ok) {
      throw new Error(`eBay update offer: ${updateOffer.status} ${await updateOffer.text()}`);
    }
  } else {
    const createOffer = await fetch(`${base}/sell/inventory/v1/offer`, {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify(offerBody),
    });
    if (!createOffer.ok) {
      const errText = await createOffer.text();
      const fromDuplicate = tryParseOfferIdFromDuplicateError(errText);
      if (fromDuplicate) {
        offerId = fromDuplicate;
        const updateBody = { ...offerBody, offerId };
        const updateOffer = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
          method: "PUT",
          headers: jsonWriteHeaders,
          body: JSON.stringify(updateBody),
        });
        if (!updateOffer.ok) {
          throw new Error(`eBay update offer (after duplicate): ${updateOffer.status} ${await updateOffer.text()}`);
        }
      } else {
        throw new Error(`eBay create offer: ${createOffer.status} ${errText}`);
      }
    } else {
      const offerJson = (await createOffer.json()) as { offerId: string };
      offerId = offerJson.offerId;
      if (!offerId) throw new Error("eBay did not return offerId");
    }
  }

  const pub = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: "POST",
    headers: commonHeaders,
  });
  if (!pub.ok) {
    throw new Error(`eBay publish: ${pub.status} ${await pub.text()}`);
  }
  const pubJson = (await pub.json()) as { listingId?: string };
  return { offerId, listingId: pubJson.listingId };
}
