import type { PlatformAdapter, AdapterResult, NormalizedListing } from "./types.js";
import {
  ebaySiteIdFromMarketplaceId,
  fetchAllMyEbayActiveListingsTrading,
} from "../ebayTradingActiveList.js";
import { localeForEbayMarketplace } from "../ebayLocale.js";

type EbayCreds = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

const EBAY_API = (sandbox: boolean) =>
  sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

/**
 * Inventory API rows are SKU-keyed; Trading API rows use listing `ItemID`. We previously skipped
 * Trading when the listing id was already “seen”, which dropped Trading’s URL/photo whenever the
 * offer call failed to return `listingId` or product images were empty. Merge Trading into the
 * Inventory row when they refer to the same listing, then append Trading-only rows.
 */
function mergeEbayTradingIntoInventoryListings(
  invListings: NormalizedListing[],
  tradingListings: NormalizedListing[]
): NormalizedListing[] {
  const usedTradingIds = new Set<string>();

  function enrich(inv: NormalizedListing, tr: NormalizedListing): void {
    if (!inv.url && tr.url) inv.url = tr.url;
    if (!inv.imageUrl && tr.imageUrl) inv.imageUrl = tr.imageUrl;
    if (!inv.listedAt && tr.listedAt) inv.listedAt = tr.listedAt;
    const lm = (inv.metadata ?? {}) as Record<string, unknown>;
    if (!lm.ebayListingId && /^\d+$/.test(String(tr.externalListingId))) {
      inv.metadata = { ...lm, ebayListingId: tr.externalListingId };
    }
  }

  for (const l of invListings) {
    let tr: NormalizedListing | undefined;
    const m = l.metadata as { ebayListingId?: string; sku?: string } | undefined;
    const fromUrl = l.url?.match(/\/itm\/(\d+)/)?.[1];
    const byItem = m?.ebayListingId ?? fromUrl;
    if (byItem) {
      tr = tradingListings.find((x) => x.externalListingId === byItem);
    }
    if (!tr) {
      const sku = m?.sku ?? l.externalListingId;
      if (sku) {
        tr = tradingListings.find(
          (x) =>
            !usedTradingIds.has(x.externalListingId) &&
            (x.metadata as { sku?: string } | undefined)?.sku === sku
        );
      }
    }
    if (tr) {
      enrich(l, tr);
      usedTradingIds.add(tr.externalListingId);
    }
  }

  const invSkus = new Set(invListings.map((x) => x.externalListingId));
  const seenItemIds = new Set<string>();
  for (const l of invListings) {
    const id = l.url?.match(/\/itm\/(\d+)/)?.[1];
    if (id) seenItemIds.add(id);
    const em = l.metadata as { ebayListingId?: string } | undefined;
    if (em?.ebayListingId) seenItemIds.add(em.ebayListingId);
  }

  const out = [...invListings];
  for (const t of tradingListings) {
    if (usedTradingIds.has(t.externalListingId)) continue;
    if (seenItemIds.has(t.externalListingId)) continue;
    const tSku = (t.metadata as { sku?: string } | undefined)?.sku;
    if (tSku && invSkus.has(tSku)) continue;
    seenItemIds.add(t.externalListingId);
    out.push(t);
  }
  return out;
}

/** Sell Inventory API rejects invalid or missing `Accept-Language` (e.g. error 25709). */
export function createEbayAdapter(sandbox: boolean, ebayMarketplaceId: string): PlatformAdapter {
  const base = EBAY_API(sandbox);
  const locale = localeForEbayMarketplace(ebayMarketplaceId);

  const headersRead = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Accept-Language": locale,
  });

  const headersJsonWrite = (token: string) => ({
    ...headersRead(token),
    "Content-Type": "application/json",
    "Content-Language": locale,
  });

  /** List `getInventoryItems` omits or abbreviates product data; bulk fetch is authoritative per SKU. */
  async function bulkGetInventoryItemDetails(
    token: string,
    skus: string[]
  ): Promise<
    Map<
      string,
      {
        title: string;
        imageUrl?: string;
        shipQty?: number;
      }
    >
  > {
    const out = new Map<string, { title: string; imageUrl?: string; shipQty?: number }>();
    for (let i = 0; i < skus.length; i += 25) {
      const chunk = skus.slice(i, i + 25);
      const res = await fetch(`${base}/sell/inventory/v1/bulk_get_inventory_item`, {
        method: "POST",
        headers: headersJsonWrite(token),
        body: JSON.stringify({ requests: chunk.map((sku) => ({ sku })) }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`eBay bulk_get_inventory_item failed: ${res.status} ${t}`);
      }
      const data = (await res.json()) as {
        responses?: Array<{
          sku?: string;
          statusCode?: number;
          inventoryItem?: {
            product?: { title?: string; imageUrls?: string[] };
            availability?: {
              shipToLocationAvailability?: { quantity?: number };
            };
          };
        }>;
      };
      for (const r of data.responses ?? []) {
        if (r.statusCode !== 200 || !r.sku) continue;
        const product = r.inventoryItem?.product;
        const title = product?.title?.trim() || r.sku;
        const urls = product?.imageUrls;
        const imageUrl =
          Array.isArray(urls) && urls.length > 0 && typeof urls[0] === "string" ? urls[0] : undefined;
        const shipQty = r.inventoryItem?.availability?.shipToLocationAvailability?.quantity;
        out.set(r.sku, {
          title,
          imageUrl,
          shipQty: typeof shipQty === "number" ? shipQty : undefined,
        });
      }
    }
    return out;
  }

  return {
    platform: "ebay",
    async fetchActiveListings(credentials: unknown, cursor?: string): Promise<
      AdapterResult<{ listings: NormalizedListing[]; nextCursor?: string }>
    > {
      const creds = credentials as EbayCreds;
      if (!creds?.accessToken) {
        return { ok: false, code: "error", message: "Missing eBay token" };
      }
      const limit = 50;
      /** eBay names this query param `offset` but it is the page index (0, 1, 2…), not a row skip. */
      const parsed = cursor ? Number(cursor) : 0;
      const pageIndex = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
      const url = new URL(`${base}/sell/inventory/v1/inventory_item`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(pageIndex));
      const res = await fetch(url, {
        headers: headersRead(creds.accessToken),
      });
      if (!res.ok) {
        const t = await res.text();
        return { ok: false, code: "error", message: `eBay inventory list failed: ${res.status} ${t}` };
      }
      const data = (await res.json()) as {
        inventoryItems?: {
          sku: string;
          product?: { title?: string; imageUrls?: string[] };
        }[];
        total?: number;
      };
      const isSandbox = base.includes("sandbox");
      const items = data.inventoryItems ?? [];
      const skus = items.map((it) => it.sku);
      let details = new Map<string, { title: string; imageUrl?: string; shipQty?: number }>();
      try {
        if (skus.length) {
          details = await bulkGetInventoryItemDetails(creds.accessToken, skus);
        }
      } catch {
        /* fall back to list payload only */
      }

      const listings: NormalizedListing[] = [];
      for (const it of items) {
        try {
          const d = details.get(it.sku);
          const title = d?.title ?? it.product?.title?.trim() ?? it.sku;
          const urls = d?.imageUrl ? [d.imageUrl] : it.product?.imageUrls;
          const imageUrl =
            Array.isArray(urls) && urls.length > 0 && typeof urls[0] === "string" ? urls[0] : undefined;

          let listingUrl: string | undefined;
          let quantity = d?.shipQty ?? 1;
          let listedAt: string | undefined;
          let offerListingId: string | undefined;

          const offerReq = new URL(`${base}/sell/inventory/v1/offer`);
          offerReq.searchParams.set("sku", it.sku);
          offerReq.searchParams.set("limit", "25");
          offerReq.searchParams.set("marketplace_id", ebayMarketplaceId);
          let offerRes = await fetch(offerReq.toString(), {
            headers: headersRead(creds.accessToken),
          });
          if (offerRes.ok) {
            let offersJson: {
              offers?: Array<{
                listingId?: string;
                availableQuantity?: number;
                listingStartDate?: string;
                marketplaceId?: string;
              }>;
            };
            try {
              offersJson = (await offerRes.json()) as typeof offersJson;
            } catch {
              offersJson = { offers: [] };
            }
            let offers = offersJson.offers ?? [];
            if (offers.length === 0) {
              const fallbackReq = new URL(`${base}/sell/inventory/v1/offer`);
              fallbackReq.searchParams.set("sku", it.sku);
              fallbackReq.searchParams.set("limit", "25");
              const fb = await fetch(fallbackReq.toString(), {
                headers: headersRead(creds.accessToken),
              });
              if (fb.ok) {
                try {
                  const fbJson = (await fb.json()) as typeof offersJson;
                  offers = fbJson.offers ?? [];
                } catch {
                  /* keep empty */
                }
              }
            }
            const offer =
              offers.find(
                (o) =>
                  o.listingId &&
                  (o.marketplaceId === ebayMarketplaceId || offers.length === 1)
              ) ?? offers.find((o) => o.listingId);
            if (offer?.listingId) {
              offerListingId = offer.listingId;
              listingUrl = isSandbox
                ? `https://sandbox.ebay.com/itm/${offer.listingId}`
                : `https://www.ebay.com/itm/${offer.listingId}`;
            }
            if (typeof offer?.availableQuantity === "number") {
              quantity = offer.availableQuantity;
            } else if (typeof d?.shipQty === "number") {
              quantity = d.shipQty;
            }
            if (typeof offer?.listingStartDate === "string" && offer.listingStartDate.length) {
              listedAt = offer.listingStartDate;
            }
          }

          listings.push({
            externalListingId: it.sku,
            title,
            quantity,
            status: "active",
            url: listingUrl,
            imageUrl,
            listedAt,
            metadata: {
              sku: it.sku,
              ...(offerListingId ? { ebayListingId: offerListingId } : {}),
            },
          });
        } catch {
          listings.push({
            externalListingId: it.sku,
            title: it.product?.title?.trim() ?? it.sku,
            quantity: 1,
            status: "active",
            metadata: { sku: it.sku },
          });
        }
      }

      if (pageIndex === 0) {
        try {
          const siteId = ebaySiteIdFromMarketplaceId(ebayMarketplaceId);
          const tradingListings = await fetchAllMyEbayActiveListingsTrading(creds.accessToken, {
            sandbox: base.includes("sandbox"),
            siteId,
          });
          const merged = mergeEbayTradingIntoInventoryListings(listings, tradingListings);
          listings.length = 0;
          listings.push(...merged);
        } catch {
          /* Trading supplements Inventory; GUI-created listings may be missing without it */
        }
      }

      const next = items.length === limit ? String(pageIndex + 1) : undefined;
      return { ok: true, data: { listings, nextCursor: next } };
    },
    async setInventoryQuantity(
      credentials: unknown,
      externalListingId: string,
      quantity: number,
      _ctx?: { shopDomain?: string }
    ): Promise<AdapterResult<void>> {
      void _ctx;
      const creds = credentials as EbayCreds;
      if (!creds?.accessToken) {
        return { ok: false, code: "error", message: "Missing eBay token" };
      }
      const getOfferUrl = new URL(`${base}/sell/inventory/v1/offer`);
      getOfferUrl.searchParams.set("sku", externalListingId);
      getOfferUrl.searchParams.set("marketplace_id", ebayMarketplaceId);
      const getOffer = await fetch(getOfferUrl.toString(), {
        headers: headersRead(creds.accessToken),
      });
      if (!getOffer.ok) {
        return {
          ok: false,
          code: "error",
          message: `eBay offer lookup failed: ${getOffer.status}`,
        };
      }
      const offers = (await getOffer.json()) as { offers?: { offerId: string }[] };
      const offerId = offers.offers?.[0]?.offerId;
      if (!offerId) {
        return { ok: false, code: "error", message: "No offer for SKU" };
      }
      const patch = await fetch(`${base}/sell/inventory/v1/offer/${offerId}`, {
        method: "PUT",
        headers: headersJsonWrite(creds.accessToken),
        body: JSON.stringify({
          availableQuantity: quantity,
          sku: externalListingId,
        }),
      });
      if (!patch.ok) {
        const t = await patch.text();
        return {
          ok: false,
          code: "error",
          message: `eBay offer update failed: ${patch.status} ${t}`,
        };
      }
      return { ok: true, data: undefined };
    },
    async deleteListing(
      credentials: unknown,
      externalListingId: string
    ): Promise<AdapterResult<void>> {
      const creds = credentials as EbayCreds;
      if (!creds?.accessToken) {
        return { ok: false, code: "error", message: "Missing eBay token" };
      }
      const res = await fetch(
        `${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(externalListingId)}`,
        {
          method: "DELETE",
          headers: headersRead(creds.accessToken),
        }
      );
      if (!res.ok && res.status !== 404) {
        const t = await res.text();
        return { ok: false, code: "error", message: `eBay delete failed: ${res.status} ${t}` };
      }
      return { ok: true, data: undefined };
    },
    async endAndRelist(credentials: unknown, externalListingId: string): Promise<AdapterResult<void>> {
      void credentials;
      void externalListingId;
      return {
        ok: false,
        code: "error",
        message: "Use listing-specific relist flow (withdraw + republish) in worker",
      };
    },
  };
}
