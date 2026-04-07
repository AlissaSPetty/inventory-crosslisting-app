import type { Env } from "../env.js";

type EbayStored = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export async function refreshEbayAccessToken(env: Env, creds: EbayStored): Promise<EbayStored> {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("eBay OAuth not configured");
  }
  if (!creds.refreshToken) {
    throw new Error("No eBay refresh token — reconnect eBay");
  }
  const tokenUrl = `https://api.${env.EBAY_SANDBOX === "false" ? "" : "sandbox."}ebay.com/identity/v1/oauth2/token`;
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`eBay token refresh failed: ${res.status} ${await res.text()}`);
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + tok.expires_in * 1000,
  };
}

export async function getValidEbayAccessToken(env: Env, creds: EbayStored): Promise<EbayStored> {
  const skew = 60_000;
  if (creds.expiresAt && creds.expiresAt > Date.now() + skew && creds.accessToken) {
    return creds;
  }
  return refreshEbayAccessToken(env, creds);
}

type AppTokenCache = { token: string; expiresAt: number };

let appTokenCache: AppTokenCache | null = null;

/** Client-credentials token for Taxonomy / Metadata read calls (no user refresh token). */
export async function getEbayApplicationAccessToken(env: Env): Promise<string> {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("eBay OAuth not configured");
  }
  const skew = 60_000;
  if (appTokenCache && appTokenCache.expiresAt > Date.now() + skew) {
    return appTokenCache.token;
  }
  const tokenUrl = `https://api.${env.EBAY_SANDBOX === "false" ? "" : "sandbox."}ebay.com/identity/v1/oauth2/token`;
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`eBay application token failed: ${res.status} ${await res.text()}`);
  }
  const tok = (await res.json()) as { access_token: string; expires_in: number };
  appTokenCache = {
    token: tok.access_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
  };
  return appTokenCache.token;
}
