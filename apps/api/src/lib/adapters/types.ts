import type { Platform } from "@inv/shared";

export type NormalizedListing = {
  externalListingId: string;
  title: string;
  priceCents?: number;
  quantity: number;
  status: string;
  url?: string;
  /** Primary image URL on the marketplace (eBay/Shopify CDN). */
  imageUrl?: string;
  /** When the listing went live on the marketplace (ISO 8601), when known. */
  listedAt?: string;
  metadata?: Record<string, unknown>;
};

/** Payload returned by `fetchActiveListings` when `ok: true`. */
export type FetchActiveListingsData = {
  listings: NormalizedListing[];
  nextCursor?: string;
  /**
   * eBay: number of `inventory_item` rows on this page from `getInventoryItems` (before live-offer filter).
   * Sync uses this to avoid pruning when the API returns an empty inventory snapshot (e.g. sandbox vs production mismatch).
   */
  ebayInventorySkusThisPage?: number;
};

export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "manual_required" | "blocked" | "error"; message: string };

export interface PlatformAdapter {
  platform: Platform;
  fetchActiveListings(
    credentials: unknown,
    cursor?: string
  ): Promise<AdapterResult<FetchActiveListingsData>>;
  setInventoryQuantity(
    credentials: unknown,
    externalListingId: string,
    quantity: number,
    ctx?: { shopDomain?: string }
  ): Promise<AdapterResult<void>>;
  deleteListing(
    credentials: unknown,
    externalListingId: string,
    ctx: { shopDomain?: string }
  ): Promise<AdapterResult<void>>;
  endAndRelist?(
    credentials: unknown,
    externalListingId: string,
    ctx: { shopDomain?: string }
  ): Promise<AdapterResult<void>>;
}
