import type { Env } from "../env.js";
import { decryptString, encryptString } from "./crypto.js";
import type { Platform } from "@inv/shared";

export function encryptPayload(env: Env, json: object): string {
  return encryptString(env.APP_ENCRYPTION_KEY, JSON.stringify(json));
}

export function decryptPayload<T>(env: Env, blob: string): T {
  return JSON.parse(decryptString(env.APP_ENCRYPTION_KEY, blob)) as T;
}

export function parseShopifyShopDomain(shop: string): string {
  const s = shop.trim().toLowerCase();
  if (!s.endsWith(".myshopify.com")) {
    return `${s.replace(/\.myshopify\.com$/i, "")}.myshopify.com`;
  }
  return s;
}

export type StoredCredentialRow = {
  platform: Platform;
  encrypted_payload: string;
  shop_domain: string | null;
};
