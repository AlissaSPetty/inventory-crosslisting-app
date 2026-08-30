/**
 * API base URL, baked at build time. Override per build with the `WXT_API_BASE`
 * env var (dev defaults to the local API). The matching origin must also appear
 * in `host_permissions` (wxt.config.ts).
 */
const raw = (import.meta.env as Record<string, string | undefined>).WXT_API_BASE;
export const API_BASE = (raw?.replace(/\/+$/, "") || "http://localhost:3001");
