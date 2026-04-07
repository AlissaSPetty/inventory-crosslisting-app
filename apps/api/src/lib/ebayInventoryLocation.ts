import { randomBytes } from "node:crypto";
import type { Env } from "../env.js";
import { getValidEbayAccessToken } from "./ebayAccessToken.js";
import { localeForEbayMarketplace } from "./ebayLocale.js";

const EBAY_API = (sandbox: boolean) =>
  sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

const PAGE_SIZE = 100;

type LocationRow = {
  merchantLocationKey?: string;
  merchantLocationStatus?: string;
  name?: string;
  locationTypes?: string[];
  [key: string]: unknown;
};

/**
 * [getInventoryLocations](https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocations) —
 * all pages (offset/limit). See [Managing inventory locations](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html).
 */
export async function fetchAllEbayInventoryLocations(
  env: Env,
  creds: { accessToken: string; refreshToken?: string; expiresAt?: number },
  existingAccessToken?: string
): Promise<
  | {
      ok: true;
      ebayApiBase: string;
      sandbox: boolean;
      total: number;
      locations: LocationRow[];
    }
  | { ok: false; error: string }
> {
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_API(sandbox);
  let token: string;
  try {
    token = existingAccessToken ?? (await getValidEbayAccessToken(env, creds)).accessToken;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const commonHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  const all: LocationRow[] = [];
  let reportedTotal: number | undefined;
  let offset = 0;

  while (true) {
    const locUrl = new URL(`${base}/sell/inventory/v1/location`);
    locUrl.searchParams.set("limit", String(PAGE_SIZE));
    locUrl.searchParams.set("offset", String(offset));
    const locRes = await fetch(locUrl, { headers: commonHeaders });
    if (!locRes.ok) {
      const body = await locRes.text();
      return { ok: false, error: `eBay locations: ${locRes.status} ${body}` };
    }

    const locJson = (await locRes.json()) as {
      total?: number;
      locations?: LocationRow[];
    };
    if (typeof locJson.total === "number") {
      reportedTotal = locJson.total;
    }
    const batch = locJson.locations ?? [];
    all.push(...batch);
    if (batch.length === 0) {
      break;
    }
    if (reportedTotal !== undefined && all.length >= reportedTotal) {
      break;
    }
    if (batch.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  const total = typeof reportedTotal === "number" ? reportedTotal : all.length;
  return { ok: true, ebayApiBase: base, sandbox, total, locations: all };
}

/** [createInventoryLocation](https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/createInventoryLocation) — warehouse type per [Creating inventory locations](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html#creating). */
export type CreateWarehouseLocationInput = {
  name: string;
  /** Optional; if empty, a unique key is generated (max 36 chars, alphanumeric + `_` `-`). */
  merchantLocationKey?: string;
  country: string;
  postalCode?: string;
  city?: string;
  stateOrProvince?: string;
};

export function generateDefaultMerchantLocationKey(): string {
  return `wh-${randomBytes(8).toString("hex")}`.slice(0, 36);
}

function normalizeMerchantLocationKey(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, "-");
  const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36);
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function createEbayWarehouseInventoryLocation(
  env: Env,
  creds: { accessToken: string; refreshToken?: string; expiresAt?: number },
  input: CreateWarehouseLocationInput,
  marketplaceId: string,
  existingAccessToken?: string
): Promise<{ ok: true; merchantLocationKey: string } | { ok: false; error: string }> {
  const country = input.country.trim().toUpperCase();
  if (country.length !== 2) {
    return { ok: false, error: "country must be a 2-letter ISO 3166 code (e.g. US)." };
  }

  const postal = input.postalCode?.trim() ?? "";
  const city = input.city?.trim() ?? "";
  const state = input.stateOrProvince?.trim() ?? "";
  if (postal) {
    /* warehouse: postal + country */
  } else if (city && state) {
    /* warehouse: city + state + country */
  } else {
    return {
      ok: false,
      error:
        "For a warehouse location, provide postal code + country, or city + state/province + country (see eBay Managing inventory locations).",
    };
  }

  const address: Record<string, string> = { country };
  if (postal) {
    address.postalCode = postal;
  } else {
    address.city = city;
    address.stateOrProvince = state;
  }

  const name = input.name.trim() || "Primary warehouse";
  const key = normalizeMerchantLocationKey(input.merchantLocationKey, generateDefaultMerchantLocationKey());

  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_API(sandbox);
  let token: string;
  try {
    token = existingAccessToken ?? (await getValidEbayAccessToken(env, creds)).accessToken;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const locale = localeForEbayMarketplace(marketplaceId);
  const pathKey = encodeURIComponent(key);
  const body = {
    name,
    location: { address },
    locationTypes: ["WAREHOUSE"],
  };

  const res = await fetch(`${base}/sell/inventory/v1/location/${pathKey}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": locale,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 204 || res.status === 201) {
    return { ok: true, merchantLocationKey: key };
  }
  const errText = await res.text();
  return { ok: false, error: `eBay createInventoryLocation: ${res.status} ${errText}` };
}

export type EbayInventoryLocationStatus = {
  /** At least one ENABLED location with merchantLocationKey. */
  ready: boolean;
  merchantLocationKey?: string;
  /** User-facing explanation when `ready` is false (missing/disabled locations). */
  message?: string;
  /** Set when the Inventory API call failed (token, HTTP, parse). */
  checkError?: string;
  /** Count from API when not ready (optional). */
  totalLocations?: number;
};

function buildMissingLocationMessage(
  sandbox: boolean,
  total: number,
  hasRowsButNoneEnabled: boolean
): string {
  const sandboxHint = sandbox
    ? " For the sandbox, sign in to the sandbox Seller Hub with your sandbox seller account and add a location there (production and sandbox locations are separate)."
    : "";
  const disabledHint = hasRowsButNoneEnabled
    ? " Locations exist but none are ENABLED (or keys missing) — enable a warehouse/business location in Seller Hub shipping settings."
    : "";
  return (
    `No enabled eBay inventory location (API reports ${total} location row(s)). Add at least one business/inventory location in Seller Hub (Shipping / business address / warehouse) so the Inventory API returns an ENABLED location with a merchantLocationKey.${sandboxHint}${disabledHint} See https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html`
  );
}

/**
 * Whether the linked seller has at least one ENABLED inventory location (required to publish offers).
 * Pass `existingAccessToken` when the caller already refreshed (avoids a second token refresh).
 */
export async function getEbayInventoryLocationStatus(
  env: Env,
  creds: { accessToken: string; refreshToken?: string; expiresAt?: number },
  existingAccessToken?: string
): Promise<EbayInventoryLocationStatus> {
  const sandbox = env.EBAY_SANDBOX !== "false";
  const fetched = await fetchAllEbayInventoryLocations(env, creds, existingAccessToken);
  if (!fetched.ok) {
    return { ready: false, checkError: fetched.error };
  }

  const rows = fetched.locations;
  const enabledLoc = rows.find((l) => {
    const status = l.merchantLocationStatus ?? "ENABLED";
    return status === "ENABLED" && Boolean(l.merchantLocationKey?.trim());
  });
  const merchantLocationKey = enabledLoc?.merchantLocationKey?.trim();
  if (merchantLocationKey) {
    return { ready: true, merchantLocationKey, totalLocations: rows.length };
  }

  const total = fetched.total;
  const hasRowsButNoneEnabled = rows.length > 0;
  return {
    ready: false,
    totalLocations: total,
    message: buildMissingLocationMessage(sandbox, total, hasRowsButNoneEnabled),
  };
}
