import type { SnapshotListing, SnapshotListingStatus } from "@inv/shared";

/**
 * Poshmark closet scraper — runs in the content script (same-origin as
 * poshmark.com, so `fetch` carries the user's session cookie).
 *
 * IMPORTANT: Poshmark exposes no public API; the `vm-rest` endpoints and DOM
 * selectors below are UNDOCUMENTED and can change without notice. Every fragile
 * field is marked `VERIFY:` — confirm each against a logged-in session's Network
 * tab before relying on production data. The raw payload is preserved in
 * `metadata` so a shape change can be reprocessed server-side.
 */

const POSH_ORIGIN = "https://poshmark.com";
const MAX_PAGES = 100;

export type ClosetScrape = {
  username: string | null;
  listings: SnapshotListing[];
  /** True only if the JSON cursor was fully drained — gates server-side pruning. */
  complete: boolean;
};

export async function scrapePoshmarkCloset(): Promise<ClosetScrape> {
  const username = resolveUsername();
  try {
    const viaJson = await scrapeViaVmRest(username);
    if (viaJson.listings.length > 0) return { username, ...viaJson };
  } catch (err) {
    console.warn("[inv-ext] vm-rest closet scrape failed; falling back to DOM", err);
  }
  // DOM sees only the currently-rendered page → never a complete snapshot.
  return { username, listings: scrapeVisibleClosetDom(), complete: false };
}

/** VERIFY: the logged-in user's own closet link in the header nav. */
function resolveUsername(): string | null {
  const href = document.querySelector<HTMLAnchorElement>('a[href^="/closet/"]')?.getAttribute("href");
  const fromNav = href?.match(/^\/closet\/([^/?#]+)/)?.[1];
  if (fromNav) return decodeURIComponent(fromNav);
  const fromPath = location.pathname.match(/^\/closet\/([^/?#]+)/)?.[1];
  return fromPath ? decodeURIComponent(fromPath) : null;
}

async function scrapeViaVmRest(
  username: string | null
): Promise<{ listings: SnapshotListing[]; complete: boolean }> {
  if (!username) throw new Error("Poshmark username could not be determined");
  const listings: SnapshotListing[] = [];
  let maxId: string | undefined;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${POSH_ORIGIN}/vm-rest/users/${encodeURIComponent(username)}/posts`);
    // VERIFY: exact query envelope + cursor param names.
    url.searchParams.set("request", JSON.stringify({ filters: { inventory_status: ["all"] } }));
    if (maxId) url.searchParams.set("max_id", maxId);

    const res = await fetch(url.toString(), {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`vm-rest ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const posts: unknown[] = Array.isArray(json?.data) ? json.data : [];
    for (const p of posts) {
      const mapped = mapPost(p);
      if (mapped) listings.push(mapped);
    }
    const next = json?.more?.next_max_id ?? json?.nextMaxId ?? null;
    if (!next || posts.length === 0) {
      complete = true;
      break;
    }
    maxId = String(next);
  }
  return { listings, complete };
}

/** VERIFY: Poshmark post shape (fields cross-referenced with community SDKs). */
function mapPost(raw: unknown): SnapshotListing | null {
  const p = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = p?.id ?? p?.post_id;
  if (!id) return null;
  const status = mapStatus(p);
  const meta: Record<string, unknown> = { raw: p };
  if (p?.brand) meta.brand = p.brand;
  const size = p?.size_obj?.display ?? p?.size;
  if (size) meta.size = size;
  if (p?.department?.display) meta.department = p.department.display;

  return {
    externalListingId: String(id),
    title: String(p?.title ?? "Untitled"),
    priceCents: dollarsToCents(p?.price_amount?.val ?? p?.price),
    quantity: status === "sold" ? 0 : 1,
    status,
    url: `${POSH_ORIGIN}/listing/${id}`,
    imageUrl: p?.covershot?.url ?? p?.picture_url ?? undefined,
    metadata: meta,
  };
}

function mapStatus(p: Record<string, unknown>): SnapshotListingStatus {
  const s = String(
    (p?.inventory as Record<string, unknown>)?.status ?? p?.status ?? ""
  ).toLowerCase();
  if (p?.sold === true || s.includes("sold")) return "sold";
  if (s.includes("reserved") || s.includes("hold")) return "reserved";
  return "available";
}

function dollarsToCents(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/** VERIFY: closet tile selectors. Best-effort single-page fallback only. */
function scrapeVisibleClosetDom(): SnapshotListing[] {
  const out: SnapshotListing[] = [];
  const tiles = document.querySelectorAll<HTMLElement>(
    '[data-et-name="listing"], .card--listing, .tile'
  );
  tiles.forEach((tile) => {
    const link = tile.querySelector<HTMLAnchorElement>('a[href*="/listing/"]');
    const href = link?.getAttribute("href") ?? "";
    const idMatch = href.match(/\/listing\/[^/]*?-([a-f0-9]{8,})/i) ?? href.match(/\/listing\/(\w+)/);
    const id = idMatch?.[1];
    if (!id) return;
    const title =
      tile.querySelector(".tile__title, .title, [data-et-name='listing_title']")?.textContent?.trim() ||
      link?.getAttribute("title")?.trim() ||
      "Untitled";
    const priceText = tile.querySelector(".p--t--1, .fw--bold, .price")?.textContent ?? "";
    const sold = /sold/i.test(tile.textContent ?? "");
    out.push({
      externalListingId: String(id),
      title,
      priceCents: dollarsToCents(priceText.replace(/[^0-9.]/g, "")),
      quantity: sold ? 0 : 1,
      status: sold ? "sold" : "available",
      url: href.startsWith("http") ? href : `${POSH_ORIGIN}${href}`,
      imageUrl: tile.querySelector<HTMLImageElement>("img")?.src,
      metadata: { via: "dom" },
    });
  });
  return out;
}
