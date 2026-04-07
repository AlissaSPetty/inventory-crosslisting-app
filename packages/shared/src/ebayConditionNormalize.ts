/**
 * eBay Metadata API returns `conditionId` as numeric strings (1000, 3000, …); Inventory API expects
 * ConditionEnum strings (NEW, USED_EXCELLENT, …). See:
 * https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html
 */

/** Metadata numeric condition ID → Inventory API ConditionEnum */
export const EBAY_METADATA_CONDITION_ID_TO_ENUM: Record<string, string> = {
  "1000": "NEW",
  "1500": "NEW_OTHER",
  "1750": "NEW_WITH_DEFECTS",
  "2000": "CERTIFIED_REFURBISHED",
  "2010": "EXCELLENT_REFURBISHED",
  "2020": "VERY_GOOD_REFURBISHED",
  "2030": "GOOD_REFURBISHED",
  "2500": "SELLER_REFURBISHED",
  "2750": "LIKE_NEW",
  "2990": "PRE_OWNED_EXCELLENT",
  "3000": "USED_EXCELLENT",
  "3010": "PRE_OWNED_FAIR",
  "4000": "USED_VERY_GOOD",
  "5000": "USED_GOOD",
  "6000": "USED_ACCEPTABLE",
  "7000": "FOR_PARTS_OR_NOT_WORKING",
};

/**
 * Convert a Metadata `conditionId` or legacy UI value to an Inventory ConditionEnum value.
 */
export function normalizeEbayConditionForInventory(raw: string | undefined): string {
  if (raw == null) return "";
  const t = raw.trim();
  if (!t) return "";
  const mapped = EBAY_METADATA_CONDITION_ID_TO_ENUM[t];
  if (mapped) return mapped;
  const upper = t.toUpperCase();
  if (upper === "USED") return "USED_GOOD";
  return t;
}
