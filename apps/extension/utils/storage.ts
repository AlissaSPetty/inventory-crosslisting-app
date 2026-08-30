import { browser } from "#imports";

const TOKEN_KEY = "deviceToken";

/**
 * The device token lives ONLY in the background/extension storage — never in the
 * content script (which shares the DOM with a potentially hostile page).
 * `chrome.storage.local` is private to this extension.
 */
export async function getDeviceToken(): Promise<string | null> {
  const r = await browser.storage.local.get(TOKEN_KEY);
  const v = r[TOKEN_KEY];
  return typeof v === "string" ? v : null;
}

export async function setDeviceToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearDeviceToken(): Promise<void> {
  await browser.storage.local.remove(TOKEN_KEY);
}
