import type {
  PlatformAdapter,
  AdapterResult,
  FetchActiveListingsData,
  NormalizedListing,
} from "./types.js";
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

type EbayOfferLite = {
  listingId?: string;
  availableQuantity?: number;
  listingStartDate?: string;
  marketplaceId?: string;
  status?: string;
  listing?: { listingId?: string; listingStatus?: string; listingOnHold?: boolean };
};

/** @see https://developer.ebay.com/api-docs/sell/inventory/types/slr:ListingStatusEnum */
const EBAY_REST_LIVE_LISTING_STATUSES = new Set(["ACTIVE", "OUT_OF_STOCK"]);

/**
 * True only when the offer’s listing is in a live sellable state on eBay (ACTIVE or OUT_OF_STOCK).
 * Rejects INACTIVE, ENDED, UNSOLD_NOT_RELISTED, empty/unknown statuses, etc.
 * @see https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers
 */
function isEbayOfferLiveForSale(o: EbayOfferLite): boolean {
  const lid = o.listingId ?? o.listing?.listingId;
  if (typeof lid !== "string" || !lid.trim()) return false;

  const offerStatus = (o.status ?? "").toUpperCase();
  if (offerStatus === "UNPUBLISHED") return false;

  if (o.listing?.listingOnHold === true) {
    return false;
  }

  const listingStatus = (o.listing?.listingStatus ?? "").toUpperCase();
  if (!listingStatus) {
    // Newly published offers sometimes return a listing id before `listing.listingStatus` is set.
    // If we skip the SKU, sync never touches the app-created `platform_listings` row and prune deletes it.
    if (offerStatus === "PUBLISHED") return true;
    if (!offerStatus.trim()) return true;
    return false;
  }
  return EBAY_REST_LIVE_LISTING_STATUSES.has(listingStatus);
}

function pickLiveOfferForMarketplace(
  offers: EbayOfferLite[],
  marketplaceId: string
): EbayOfferLite | undefined {
  const live = offers.filter(isEbayOfferLiveForSale);
  if (!live.length) return undefined;
  const byMp = live.find((o) => o.marketplaceId === marketplaceId);
  if (byMp) return byMp;
  if (live.length === 1) return live[0];
  return live.find((o) => o.listingId ?? o.listing?.listingId);
}

/**
 * Sell Inventory + live offers is the primary snapshot. `GetMyeBaySelling` ActiveList first
 * **enriches** those rows, then (see `appendEbayTradingActiveListingsNotInInventorySnapshot`) adds
 * ActiveList-only lines — listings that are live on eBay but not returned as inventory items (e.g.
 * classic / non–REST inventory flows) still have `ListingStatus` **Active** in Trading XML.
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

  return invListings;
}

/**
 * `getInventoryItems` can omit SKUs for listings that were never tied to the Inventory API. Active
 * list from Trading is already restricted to `ListingStatus` = Active; append rows not already
 * represented in the inventory snapshot (same item id or SKU as an inv row).
 */
function appendEbayTradingActiveListingsNotInInventorySnapshot(
  invListings: NormalizedListing[],
  tradingListings: NormalizedListing[]
): NormalizedListing[] {
  const out = [...invListings];

  function invCoversTradingRow(t: NormalizedListing): boolean {
    const tItem = t.externalListingId;
    const tSku = (t.metadata as { sku?: string } | undefined)?.sku;
    for (const l of invListings) {
      const m = l.metadata as { ebayListingId?: string; sku?: string } | undefined;
      const fromUrl = l.url?.match(/\/itm\/(\d+)/)?.[1];
      if (m?.ebayListingId && m.ebayListingId === tItem) return true;
      if (fromUrl && fromUrl === tItem) return true;
      if (l.externalListingId != null && String(l.externalListingId) === tItem) return true;
      if (tSku) {
        if (m?.sku && m.sku === tSku) return true;
        if (String(l.externalListingId) === tSku) return true;
      }
    }
    return false;
  }

  for (const t of tradingListings) {
    if (!invCoversTradingRow(t)) out.push(t);
  }
  return out;
}

/**
 * One logical listing can appear twice before merge (e.g. SKU row + Trading row with same ItemID).
 * Collapse to a single row per eBay listing id or SKU so sync `total` matches user-visible listings.
 */
function dedupeEbayNormalizedListings(rows: NormalizedListing[]): NormalizedListing[] {
  const byKey = new Map<string, NormalizedListing>();

  function keyFor(r: NormalizedListing): string {
    const m = r.metadata as { ebayListingId?: string } | undefined;
    const fromUrl = r.url?.match(/\/itm\/(\d+)/)?.[1];
    const itemId = m?.ebayListingId ?? (fromUrl && /^\d+$/.test(fromUrl) ? fromUrl : undefined);
    if (itemId && /^\d+$/.test(String(itemId))) {
      return `item:${itemId}`;
    }
    return `sku:${String(r.externalListingId)}`;
  }

  function score(r: NormalizedListing): number {
    const m = r.metadata as { sku?: string } | undefined;
    let s = 0;
    if (r.url) s += 4;
    if (r.imageUrl) s += 2;
    if (m?.sku) s += 1;
    if (r.title?.trim()) s += 1;
    return s;
  }

  for (const r of rows) {
    const k = keyFor(r);
    const prev = byKey.get(k);
    if (!prev || score(r) > score(prev)) {
      byKey.set(k, r);
    }
  }
  return [...byKey.values()];
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
      AdapterResult<FetchActiveListingsData>
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
            let offersJson: { offers?: EbayOfferLite[] };
            try {
              offersJson = (await offerRes.json()) as { offers?: EbayOfferLite[] };
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
                  const fbJson = (await fb.json()) as { offers?: EbayOfferLite[] };
                  offers = fbJson.offers ?? [];
                } catch {
                  /* keep empty */
                }
              }
            }
            const offer = pickLiveOfferForMarketplace(offers, ebayMarketplaceId);
            if (!offer) {
              continue;
            }
            const oid = offer.listingId ?? offer.listing?.listingId;
            if (oid) {
              offerListingId = oid;
              listingUrl = isSandbox
                ? `https://sandbox.ebay.com/itm/${oid}`
                : `https://www.ebay.com/itm/${oid}`;
            }
            if (typeof offer.availableQuantity === "number") {
              quantity = offer.availableQuantity;
            } else if (typeof d?.shipQty === "number") {
              quantity = d.shipQty;
            }
            if (typeof offer.listingStartDate === "string" && offer.listingStartDate.length) {
              listedAt = offer.listingStartDate;
            }
          } else {
            continue;
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
          /* Skip SKUs we cannot classify as a live published listing */
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
          const withTradingOnly = appendEbayTradingActiveListingsNotInInventorySnapshot(
            merged,
            tradingListings
          );
          listings.length = 0;
          listings.push(...withTradingOnly);
        } catch {
          /* Trading supplements Inventory; GUI-created listings may be missing without it */
        }
      }

      const next = items.length === limit ? String(pageIndex + 1) : undefined;
      return {
        ok: true,
        data: {
          listings: dedupeEbayNormalizedListings(listings),
          nextCursor: next,
          ebayInventorySkusThisPage: items.length,
        },
      };
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
