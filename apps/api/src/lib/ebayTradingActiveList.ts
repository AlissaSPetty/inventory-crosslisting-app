import type { NormalizedListing } from "./adapters/types.js";

/** eBay Trading API site IDs (US = 0). @see https://developer.ebay.com/DevZone/merch/ebaysiteid.txt */
export function ebaySiteIdFromMarketplaceId(marketplaceId: string): number {
  const m: Record<string, number> = {
    EBAY_US: 0,
    EBAY_MOTORS_US: 0,
    EBAY_CA: 2,
    EBAY_GB: 3,
    EBAY_AU: 15,
    EBAY_AT: 16,
    EBAY_FR: 71,
    EBAY_DE: 77,
    EBAY_IT: 101,
    EBAY_NL: 146,
    EBAY_ES: 186,
    EBAY_CH: 193,
    EBAY_IE: 205,
    EBAY_PL: 212,
  };
  return m[marketplaceId] ?? 0;
}

function tradingApiBase(sandbox: boolean): string {
  return sandbox ? "https://api.sandbox.ebay.com/ws/api.dll" : "https://api.ebay.com/ws/api.dll";
}

/** @see https://developer.ebay.com/api-docs/static/oauth-trad-apis.html — must be `SITEID`, not `SITE-ID`. */
function tradingHeaders(token: string, siteId: number, callName: string): Record<string, string> {
  return {
    "Content-Type": "text/xml; charset=UTF-8",
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-SITEID": String(siteId),
    "X-EBAY-API-COMPATIBILITY-LEVEL": "1423",
    "X-EBAY-API-IAF-TOKEN": token,
  };
}

/** ActiveList may use namespace prefixes (`ebl:ActiveList`). */
function extractActiveListInnerXml(xml: string): string | null {
  const open = xml.match(/<(?:[\w.-]+:)?ActiveList\b[^>]*>/i);
  if (!open || open.index === undefined) return null;
  const start = open.index + open[0].length;
  const rest = xml.slice(start);
  const close = rest.match(/<\/(?:[\w.-]+:)?ActiveList\s*>/i);
  if (!close || close.index === undefined) return null;
  return rest.slice(0, close.index);
}

function parsePaginationInSection(sectionXml: string): { totalPages: number } {
  const tp = sectionXml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/i);
  return {
    totalPages: tp ? Math.max(1, Number(tp[1])) : 1,
  };
}

/** Trading Item blocks may include multiple `<PictureURL>` tags or a single `GalleryURL`. */
function firstPictureUrlFromItemBlock(block: string): string | undefined {
  const picRe = /<(?:[\w.-]+:)?PictureURL>([^<]*)<\/(?:[\w.-]+:)?PictureURL>/gi;
  let m: RegExpExecArray | null;
  while ((m = picRe.exec(block)) !== null) {
    const u = m[1]?.trim();
    if (u) return u;
  }
  const g = block.match(/<(?:[\w.-]+:)?GalleryURL>([^<]*)<\/(?:[\w.-]+:)?GalleryURL>/i);
  const gu = g?.[1]?.trim();
  return gu || undefined;
}

function parseItemFromBlock(
  block: string,
  itmBase: string,
  opts?: { activeListingOnly?: boolean; listingSource?: string }
): NormalizedListing | null {
  if (opts?.activeListingOnly) {
    const ls = block.match(/<(?:[\w.-]+:)?ListingStatus>([^<]*)<\/(?:[\w.-]+:)?ListingStatus>/i);
    const v = ls?.[1]?.trim().toLowerCase();
    if (v && v !== "active") return null;
  }

  const idM = block.match(/<(?:[\w.-]+:)?ItemID>(\d+)<\/(?:[\w.-]+:)?ItemID>/i);
  if (!idM) return null;
  const itemId = idM[1];
  const titleM = block.match(/<(?:[\w.-]+:)?Title>([^<]*)<\/(?:[\w.-]+:)?Title>/i);
  const title = titleM?.[1]?.trim() || `Listing ${itemId}`;
  const skuM = block.match(/<(?:[\w.-]+:)?SKU>([^<]*)<\/(?:[\w.-]+:)?SKU>/i);
  const sku = skuM?.[1]?.trim();
  let qty = 1;
  const qM = block.match(/<(?:[\w.-]+:)?QuantityAvailable>(\d+)<\/(?:[\w.-]+:)?QuantityAvailable>/i);
  if (qM) qty = Number(qM[1]);
  else {
    const q2 = block.match(/<(?:[\w.-]+:)?Quantity>(\d+)<\/(?:[\w.-]+:)?Quantity>/i);
    if (q2) qty = Number(q2[1]);
  }
  let imageUrl = firstPictureUrlFromItemBlock(block);
  let listedAt: string | undefined;
  const st = block.match(/<(?:[\w.-]+:)?StartTime>([^<]+)<\/(?:[\w.-]+:)?StartTime>/i);
  if (st?.[1]) listedAt = st[1].trim();

  return {
    externalListingId: itemId,
    title,
    quantity: qty,
    status: "active",
    url: `${itmBase}${itemId}`,
    imageUrl,
    listedAt,
    metadata: {
      source: opts?.listingSource ?? "trading_get_my_ebay_selling",
      ...(sku ? { sku } : {}),
    },
  };
}

/**
 * Walk `<Item>` / `<ns:Item>` blocks without assuming a single regex can pair tags across namespaces.
 */
function parseItemsFromItemBlocks(
  xml: string,
  itmBase: string,
  opts?: { activeListingOnly?: boolean; listingSource?: string }
): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const re = /<([\w.-]+:)?Item\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const prefix = m[1] ?? "";
    const start = m.index + m[0].length;
    const closeTag = `</${prefix}Item>`;
    const end = xml.indexOf(closeTag, start);
    if (end === -1) continue;
    const block = xml.slice(start, end);
    const parsed = parseItemFromBlock(block, itmBase, opts);
    if (parsed) out.push(parsed);
  }
  return out;
}

async function postTradingXml(
  base: string,
  token: string,
  siteId: number,
  callName: string,
  body: string
): Promise<string> {
  const res = await fetch(base, {
    method: "POST",
    headers: tradingHeaders(token, siteId, callName),
    body,
  });
  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`${callName} HTTP ${res.status}: ${xml.slice(0, 500)}`);
  }
  const ackM = xml.match(/<Ack>(\w+)<\/Ack>/i);
  const ack = ackM?.[1]?.toUpperCase();
  if (ack === "FAILURE") {
    const err = xml.match(/<ShortMessage>([^<]*)<\/ShortMessage>/i);
    throw new Error(err?.[1]?.trim() || `${callName} Ack Failure`);
  }
  return xml;
}

async function fetchGetMyeBaySellingPages(
  base: string,
  token: string,
  siteId: number,
  itmBase: string
): Promise<NormalizedListing[]> {
  const all: NormalizedListing[] = [];

  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

    const xml = await postTradingXml(base, token, siteId, "GetMyeBaySelling", body);

    const activeInner = extractActiveListInnerXml(xml);
    if (!activeInner) {
      if (pageNumber === 1) {
        all.push(...parseItemsFromItemBlocks(xml, itmBase));
      }
      break;
    }

    const { totalPages } = parsePaginationInSection(activeInner);
    all.push(...parseItemsFromItemBlocks(activeInner, itmBase));

    if (pageNumber >= totalPages) break;
  }

  return all;
}

async function fetchGetSellerListPages(
  base: string,
  token: string,
  siteId: number,
  itmBase: string
): Promise<NormalizedListing[]> {
  const all: NormalizedListing[] = [];
  const endFrom = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const endTo = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <GranularityLevel>Fine</GranularityLevel>
  <EndTimeFrom>${endFrom}</EndTimeFrom>
  <EndTimeTo>${endTo}</EndTimeTo>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
</GetSellerListRequest>`;

    const xml = await postTradingXml(base, token, siteId, "GetSellerList", body);
    all.push(
      ...parseItemsFromItemBlocks(xml, itmBase, {
        activeListingOnly: true,
        listingSource: "trading_get_seller_list",
      })
    );

    const tp = xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/i);
    const totalPages = tp ? Math.max(1, Number(tp[1])) : 1;

    if (pageNumber >= totalPages) break;
  }

  return dedupeByItemId(all);
}

function dedupeByItemId(rows: NormalizedListing[]): NormalizedListing[] {
  const seen = new Set<string>();
  const out: NormalizedListing[] = [];
  for (const r of rows) {
    if (seen.has(r.externalListingId)) continue;
    seen.add(r.externalListingId);
    out.push(r);
  }
  return out;
}

export async function fetchAllMyEbayActiveListingsTrading(
  accessToken: string,
  opts: { sandbox: boolean; siteId: number }
): Promise<NormalizedListing[]> {
  const base = tradingApiBase(opts.sandbox);
  const itmBase = opts.sandbox ? "https://sandbox.ebay.com/itm/" : "https://www.ebay.com/itm/";

  let myebay = await fetchGetMyeBaySellingPages(base, accessToken, opts.siteId, itmBase);
  myebay = dedupeByItemId(myebay);

  /** Always merge GetSellerList: GUI-only listings are often absent from GetMyeBaySelling when other rows exist. */
  let sellerList: NormalizedListing[] = [];
  try {
    sellerList = await fetchGetSellerListPages(base, accessToken, opts.siteId, itmBase);
  } catch {
    /* optional supplement */
  }

  return dedupeByItemId([...myebay, ...sellerList]);
}
