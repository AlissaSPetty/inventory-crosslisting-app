import { defineContentScript, browser } from "#imports";
import type { ExtensionSnapshot } from "@inv/shared";
import { scrapePoshmarkCloset } from "@/utils/poshmark";
import type { RuntimeMessage, SyncResponse } from "@/utils/messages";

/** Don't auto-sync more often than this (a full large-closet scrape is heavy). */
const AUTOSYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_SYNC_KEY = "lastSyncAt";

export default defineContentScript({
  matches: ["*://*.poshmark.com/*"],
  runAt: "document_idle",
  main() {
    // Marker so the app/diagnostics can confirm the content script is injected.
    try {
      document.documentElement.dataset.invExt = "1";
    } catch {
      /* ignore */
    }
    console.log("[inv-ext] content script active on", location.pathname);

    browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
      if (message.type !== "SYNC_POSHMARK") return;
      runSync("manual").then(sendResponse);
      return true; // async response
    });

    // Gentle auto-sync when viewing your own closet, throttled so it doesn't
    // re-scrape a large closet on every visit.
    if (/^\/closet\//.test(location.pathname)) {
      void maybeAutoSync();
    }
  },
});

async function maybeAutoSync(): Promise<void> {
  try {
    const rec = await browser.storage.local.get(LAST_SYNC_KEY);
    const last = typeof rec[LAST_SYNC_KEY] === "number" ? (rec[LAST_SYNC_KEY] as number) : 0;
    if (Date.now() - last < AUTOSYNC_MIN_INTERVAL_MS) {
      console.log("[inv-ext] auto-sync skipped (synced recently)");
      return;
    }
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 3000)); // let the page settle
  await runSync("auto");
}

async function runSync(trigger: "manual" | "auto"): Promise<SyncResponse> {
  try {
    console.log(`[inv-ext] ${trigger} sync starting…`);
    const scrape = await scrapePoshmarkCloset();
    if (scrape.listings.length === 0) {
      console.warn("[inv-ext] scrape returned 0 listings — nothing to sync");
      return { ok: false, error: "No listings found — open your closet page and retry." };
    }
    const snapshot: ExtensionSnapshot = {
      platform: "poshmark",
      complete: scrape.complete,
      username: scrape.username ?? undefined,
      listings: scrape.listings,
    };
    console.log(`[inv-ext] pushing ${scrape.listings.length} listings (complete=${scrape.complete})…`);
    const res = (await browser.runtime.sendMessage({ type: "PM_SNAPSHOT", snapshot })) as SyncResponse;
    console.log("[inv-ext] push result:", res);
    if (res?.ok) {
      try {
        await browser.storage.local.set({ [LAST_SYNC_KEY]: Date.now() });
      } catch {
        /* ignore */
      }
    }
    return res;
  } catch (e) {
    console.warn("[inv-ext] sync failed", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
