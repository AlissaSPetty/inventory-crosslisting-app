import { defineContentScript, browser } from "#imports";
import type { ExtensionSnapshot } from "@inv/shared";
import { scrapePoshmarkCloset } from "@/utils/poshmark";
import type { RuntimeMessage, SyncResponse } from "@/utils/messages";

export default defineContentScript({
  matches: ["*://*.poshmark.com/*"],
  runAt: "document_idle",
  main() {
    browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
      if (message.type !== "SYNC_POSHMARK") return;
      runSync().then(sendResponse);
      return true; // async response
    });

    // Gentle auto-sync when the user is already viewing their closet.
    if (/^\/closet\//.test(location.pathname)) {
      setTimeout(() => void runSync(), 4000);
    }
  },
});

async function runSync(): Promise<SyncResponse> {
  try {
    const scrape = await scrapePoshmarkCloset();
    if (scrape.listings.length === 0) {
      return { ok: false, error: "No listings found — open your closet page and retry." };
    }
    const snapshot: ExtensionSnapshot = {
      platform: "poshmark",
      complete: scrape.complete,
      username: scrape.username ?? undefined,
      listings: scrape.listings,
    };
    return (await browser.runtime.sendMessage({ type: "PM_SNAPSHOT", snapshot })) as SyncResponse;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
