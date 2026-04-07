import type { Platform } from "@inv/shared";
import type { PlatformAdapter } from "./types.js";
import { createEbayAdapter } from "./ebay.js";
import { createShopifyAdapter } from "./shopify.js";
import { createDepopAdapter } from "./depop.js";
import { createHybridAdapter } from "./hybrid.js";

export function buildAdapters(env: {
  EBAY_SANDBOX?: string;
  EBAY_MARKETPLACE_ID?: string;
}): Record<Platform, PlatformAdapter> {
  const sandbox = env.EBAY_SANDBOX !== "false";
  const ebayMarketplaceId = env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
  return {
    ebay: createEbayAdapter(sandbox, ebayMarketplaceId),
    shopify: createShopifyAdapter(),
    depop: createDepopAdapter(),
    poshmark: createHybridAdapter("poshmark"),
    mercari: createHybridAdapter("mercari"),
  };
}
