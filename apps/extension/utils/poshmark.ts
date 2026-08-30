import { SNAPSHOT_MAX_LISTINGS } from "@inv/shared";
import type { SnapshotListing, SnapshotListingStatus } from "@inv/shared";

/**
 * Poshmark closet scraper — runs in the content script (same-origin as
 * poshmark.com, so `fetch` carries the user's session cookie).
 *
 * Poshmark has no public API. The `vm-rest` endpoint below is undocumented but
 * was confirmed against the live public closet endpoint (2026): a logged-in
 * session returns the SAME shape via same-origin cookies, plus the seller's
 * private/non-public items. Poshmark can still change it without notice — the
 * DOM fallback and the per-item field guards keep a change from hard-failing.
 *
 *   GET /vm-rest/users/{username}/posts?count=48[&max_id=<cursor>]
 *   -> { data: Post[], more: { next_max_id }, trace_id }
 *
 * Pagination is the `more.next_max_id` cursor — the `offset` param is IGNORED by
 * this endpoint (it always returns page 1), so a cursor walk is required.
 */

const POSH_ORIGIN = "https://poshmark.com";
const PAGE_COUNT = 48;
const MAX_PAGES = 200;
/** Pace requests — Poshmark throttles rapid vm-rest calls (≈1/s sustained). */
const PAGE_DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Post = Record<string, any>;

export type ClosetScrape = {
  username: string | null;
  listings: SnapshotListing[];
  /** True only if pagination was fully drained — gates server-side pruning. */
  complete: boolean;
};

export async function scrapePoshmarkCloset(): Promise<ClosetScrape> {
  const username = resolveUsername();
  console.log("[inv-ext] scraping closet for", username);
  try {
    const viaJson = await scrapeViaVmRest(username);
    console.log(`[inv-ext] scraped ${viaJson.listings.length} listings (complete=${viaJson.complete})`);
    if (viaJson.listings.length > 0 || viaJson.complete) {
      return { username, ...viaJson };
    }
  } catch (err) {
    console.warn("[inv-ext] vm-rest closet scrape failed; falling back to DOM", err);
  }
  // DOM sees only the currently-rendered page → never a complete snapshot.
  return { username, listings: scrapeVisibleClosetDom(), complete: false };
}

/** The logged-in user's own closet link in the header nav (or the current closet URL). */
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
  const seen = new Set<string>();
  let complete = false;
  let maxId: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${POSH_ORIGIN}/vm-rest/users/${encodeURIComponent(username)}/posts`);
    url.searchParams.set("count", String(PAGE_COUNT));
    if (maxId != null) url.searchParams.set("max_id", maxId);
    const res = await fetch(url.toString(), { credentials: "include", headers: { accept: "application/json" } });
    if (!res.ok) {
      // Throttled / transient error: sync what we have so far. `complete:false`
      // means the server will NOT prune, so a partial pull can't delete rows.
      console.warn(`[inv-ext] vm-rest page ${page} HTTP ${res.status}; syncing ${listings.length} collected (partial)`);
      return { listings, complete: false };
    }
    const json = (await res.json()) as { data?: unknown; more?: { next_max_id?: unknown } };
    const posts: unknown[] = Array.isArray(json.data) ? json.data : [];
    for (const p of posts) {
      const mapped = mapPost(p);
      if (mapped && !seen.has(mapped.externalListingId)) {
        seen.add(mapped.externalListingId);
        listings.push(mapped);
      }
    }
    const next = json.more?.next_max_id;
    // No cursor (or an empty page) means the closet is fully drained.
    if (next == null || posts.length === 0) {
      complete = true;
      break;
    }
    if (listings.length >= SNAPSHOT_MAX_LISTINGS) {
      console.warn(`[inv-ext] reached ${SNAPSHOT_MAX_LISTINGS}-listing cap; syncing partial`);
      return { listings: listings.slice(0, SNAPSHOT_MAX_LISTINGS), complete: false };
    }
    maxId = String(next);
    await sleep(PAGE_DELAY_MS);
  }
  return { listings, complete };
}

function mapPost(raw: unknown): SnapshotListing | null {
  const p = raw as Post;
  const id = p?.id;
  if (!id) return null;
  const status = mapStatus(p);
  const title = String(p?.title ?? "Untitled");

  const meta: Record<string, unknown> = {};
  if (p?.brand) meta.brand = p.brand;
  const size = p?.size_obj?.display ?? p?.size;
  if (size) meta.size = size;
  if (p?.department?.display) meta.department = p.department.display;
  if (p?.category_v2?.display) meta.category = p.category_v2.display;
  if (Array.isArray(p?.inventory?.size_quantities) &&
      p.inventory.size_quantities.some((q: Post) => q?.condition === "nwt")) {
    meta.nwt = true;
  }

  return {
    externalListingId: String(id),
    title,
    priceCents: dollarsToCents(p?.price_amount?.val ?? p?.price),
    quantity: status === "sold" ? 0 : 1,
    status,
    url: `${POSH_ORIGIN}/listing/${listingSlug(title)}-${id}`,
    imageUrl: typeof p?.cover_shot?.url === "string" ? p.cover_shot.url : undefined,
    listedAt: typeof p?.created_at === "string" ? p.created_at : undefined,
    metadata: meta,
  };
}

/** `inventory.status`: available | sold_out | reserved | not_for_sale. */
function mapStatus(p: Post): SnapshotListingStatus {
  const s = String(p?.inventory?.status ?? p?.status ?? "").toLowerCase();
  if (s === "sold_out" || s.includes("sold")) return "sold";
  if (s === "reserved" || s === "not_for_sale" || s.includes("reserve") || s.includes("hold")) {
    return "reserved";
  }
  return "available";
}

function dollarsToCents(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/** Poshmark listing URLs are `/listing/{title-slug}-{id}`; the slug is cosmetic. */
function listingSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "listing"
  );
}

/** Best-effort single-page fallback if the JSON endpoint ever changes shape. */
function scrapeVisibleClosetDom(): SnapshotListing[] {
  const out: SnapshotListing[] = [];
  const tiles = document.querySelectorAll<HTMLElement>('[data-et-name="listing"], .card--listing, .tile');
  tiles.forEach((tile) => {
    const href = tile.querySelector<HTMLAnchorElement>('a[href*="/listing/"]')?.getAttribute("href") ?? "";
    const id = href.match(/-([a-f0-9]{24})(?:$|[/?#])/i)?.[1] ?? href.match(/\/listing\/(\w+)/)?.[1];
    if (!id) return;
    const title =
      tile.querySelector(".tile__title, .title, [data-et-name='listing_title']")?.textContent?.trim() ||
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
