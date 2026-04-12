import type {
  PlatformAdapter,
  AdapterResult,
  FetchActiveListingsData,
  NormalizedListing,
} from "./types.js";

type ShopifyCreds = {
  accessToken: string;
  shopDomain: string;
};

async function rest(
  shop: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`https://${shop}/admin/api/2024-10${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      ...init?.headers,
    },
  });
}

export function createShopifyAdapter(): PlatformAdapter {
  return {
    platform: "shopify",
    async fetchActiveListings(credentials: unknown, cursor?: string): Promise<
      AdapterResult<FetchActiveListingsData>
    > {
      const creds = credentials as ShopifyCreds;
      if (!creds?.accessToken || !creds.shopDomain) {
        return { ok: false, code: "error", message: "Missing Shopify session" };
      }
      const page = cursor ? JSON.parse(cursor) as { page: string } : { page: "1" };
      const pageInfo = new URLSearchParams({
        limit: "50",
        page: page.page,
        /** Draft/archived products are not for sale on the storefront. */
        status: "active",
      });
      const res = await rest(creds.shopDomain, creds.accessToken, `/products.json?${pageInfo}`);
      if (!res.ok) {
        return { ok: false, code: "error", message: await res.text() };
      }
      const data = (await res.json()) as {
        products?: {
          id: number;
          title: string;
          created_at?: string;
          image?: { src?: string | null };
          images?: { src?: string | null }[];
          variants: { id: number; inventory_item_id: number; inventory_quantity: number }[];
        }[];
      };
      const shop = creds.shopDomain;
      const listings: NormalizedListing[] = [];
      for (const p of data.products ?? []) {
        const v = p.variants[0];
        if (!v) continue;
        const imageUrl =
          (p.image?.src && String(p.image.src)) ||
          (p.images?.[0]?.src && String(p.images[0].src)) ||
          undefined;
        listings.push({
          externalListingId: `gid://shopify/Product/${p.id}`,
          title: p.title,
          quantity: v.inventory_quantity ?? 0,
          status: "active",
          url: `https://${shop}/admin/products/${p.id}`,
          imageUrl,
          listedAt: typeof p.created_at === "string" ? p.created_at : undefined,
          metadata: {
            variantId: v.id,
            inventoryItemId: v.inventory_item_id,
          },
        });
      }
      const next =
        (data.products?.length ?? 0) === 50
          ? JSON.stringify({ page: String(Number(page.page) + 1) })
          : undefined;
      return { ok: true, data: { listings, nextCursor: next } };
    },
    async setInventoryQuantity(
      credentials: unknown,
      externalListingId: string,
      quantity: number,
      ctx: { shopDomain?: string }
    ): Promise<AdapterResult<void>> {
      const creds = credentials as ShopifyCreds;
      const shop = ctx.shopDomain ?? creds.shopDomain;
      if (!creds?.accessToken || !shop) {
        return { ok: false, code: "error", message: "Missing Shopify session" };
      }
      const locRes = await rest(shop, creds.accessToken, "/locations.json");
      if (!locRes.ok) {
        return { ok: false, code: "error", message: await locRes.text() };
      }
      const locs = (await locRes.json()) as { locations?: { id: number }[] };
      const locationId = locs.locations?.[0]?.id;
      if (!locationId) {
        return { ok: false, code: "error", message: "No Shopify location" };
      }
      const numeric = externalListingId.replace(/\D/g, "");
      const pid = Number(numeric);
      if (!pid) {
        return { ok: false, code: "error", message: "Invalid product id" };
      }
      const pRes = await rest(shop, creds.accessToken, `/products/${pid}.json`);
      if (!pRes.ok) {
        return { ok: false, code: "error", message: await pRes.text() };
      }
      const pj = (await pRes.json()) as {
        product?: { variants?: { inventory_item_id: number }[] };
      };
      const inventoryItemId = pj.product?.variants?.[0]?.inventory_item_id;
      if (!inventoryItemId) {
        return { ok: false, code: "error", message: "No inventory item" };
      }
      const setRes = await rest(shop, creds.accessToken, "/inventory_levels/set.json", {
        method: "POST",
        body: JSON.stringify({
          location_id: locationId,
          inventory_item_id: inventoryItemId,
          available: quantity,
        }),
      });
      if (!setRes.ok) {
        return { ok: false, code: "error", message: await setRes.text() };
      }
      return { ok: true, data: undefined };
    },
    async deleteListing(
      credentials: unknown,
      externalListingId: string,
      ctx: { shopDomain?: string }
    ): Promise<AdapterResult<void>> {
      const creds = credentials as ShopifyCreds;
      const shop = ctx.shopDomain ?? creds.shopDomain;
      if (!creds?.accessToken || !shop) {
        return { ok: false, code: "error", message: "Missing Shopify session" };
      }
      const numeric = externalListingId.replace(/\D/g, "");
      const pid = Number(numeric);
      if (!pid) {
        return { ok: false, code: "error", message: "Invalid product id" };
      }
      const res = await rest(shop, creds.accessToken, `/products/${pid}.json`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        return { ok: false, code: "error", message: await res.text() };
      }
      return { ok: true, data: undefined };
    },
  };
}
