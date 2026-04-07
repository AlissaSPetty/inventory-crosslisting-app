export const PLATFORMS = [
  "ebay",
  "shopify",
  "depop",
  "poshmark",
  "mercari",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export type InventoryStatus = "active" | "sold" | "archived";

export type ListingSource = "app" | "sync_fetch" | "manual_link";

export * from "./draftEditor.js";
export * from "./draftValidation.js";
export * from "./ebayConditionNormalize.js";
