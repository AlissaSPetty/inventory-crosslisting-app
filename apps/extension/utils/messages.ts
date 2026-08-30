import type { ExtensionSnapshot } from "@inv/shared";

/** Messages exchanged between popup, content script, and background worker. */
export type RuntimeMessage =
  | { type: "PAIR"; code: string; label?: string }
  | { type: "GET_STATUS" }
  | { type: "SYNC_POSHMARK" } // popup/alarm → content script (does the scrape)
  | { type: "PM_SNAPSHOT"; snapshot: ExtensionSnapshot }; // content script → background (pushes to API)

export type PairResponse = { ok: boolean; error?: string };

export type SyncResponse = {
  ok: boolean;
  imported?: number;
  pruned?: number;
  error?: string;
};

export type StatusResponse = {
  ok: boolean;
  paired: boolean;
  poshmark?: { username: string | null; connectedAt?: string } | null;
  error?: string;
};
