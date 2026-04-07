/** BCP-47 locale for eBay REST `Content-Language` / `Accept-Language` (see Marketplace ID values in eBay REST docs). */
export function localeForEbayMarketplace(marketplaceId: string): string {
  const map: Record<string, string> = {
    EBAY_US: "en-US",
    EBAY_MOTORS_US: "en-US",
    EBAY_GB: "en-GB",
    EBAY_DE: "de-DE",
    EBAY_AU: "en-AU",
    EBAY_AT: "de-AT",
    EBAY_BE: "nl-BE",
    EBAY_CA: "en-CA",
    EBAY_CH: "de-CH",
    EBAY_ES: "es-ES",
    EBAY_FR: "fr-FR",
    EBAY_HK: "zh-HK",
    EBAY_IE: "en-IE",
    EBAY_IT: "it-IT",
    EBAY_MY: "en-US",
    EBAY_NL: "nl-NL",
    EBAY_PH: "en-PH",
    EBAY_PL: "pl-PL",
    EBAY_SG: "en-US",
    EBAY_TW: "zh-TW",
  };
  return map[marketplaceId] ?? "en-US";
}
