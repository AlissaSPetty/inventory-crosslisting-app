/** Validation limits for multi-platform listing draft editor (UI + API hints). */

/** Max photos stored per inventory item (inventory upload + draft editor Add). */
export const INVENTORY_PHOTOS_MAX = 10;
/** When opening the draft editor with no saved selection, include this many photos (by sort order). */
export const DRAFT_EDITOR_INITIAL_PHOTO_COUNT = 5;

export const EBAY_TITLE_MAX = 80;
export const EBAY_DESCRIPTION_MAX = 4000;
export const SHOPIFY_TITLE_MAX = 255;

export const EBAY_CONDITIONS = [
  "NEW",
  "LIKE_NEW",
  "NEW_OTHER",
  "NEW_WITH_DEFECTS",
  "MANUFACTURER_REFURBISHED",
  "CERTIFIED_REFURBISHED",
  "EXCELLENT_REFURBISHED",
  "VERY_GOOD_REFURBISHED",
  "GOOD_REFURBISHED",
  "SELLER_REFURBISHED",
  "USED_EXCELLENT",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
  "PRE_OWNED_EXCELLENT",
  "PRE_OWNED_FAIR",
] as const;

export type EbayCondition = (typeof EBAY_CONDITIONS)[number];
