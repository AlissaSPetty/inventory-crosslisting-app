import { defineBackground, browser } from "#imports";
import type { ExtensionSnapshot } from "@inv/shared";
import { API_BASE } from "@/utils/config";
import { getDeviceToken, setDeviceToken } from "@/utils/storage";
import type {
  PairResponse,
  RuntimeMessage,
  StatusResponse,
  SyncResponse,
} from "@/utils/messages";

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    (async () => {
      try {
        if (message.type === "PAIR") return sendResponse(await handlePair(message.code, message.label));
        if (message.type === "PM_SNAPSHOT") return sendResponse(await handleSnapshot(message.snapshot));
        if (message.type === "GET_STATUS") return sendResponse(await handleStatus());
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // keep the message channel open for the async response
  });

  // Gentle periodic sync — only if a Poshmark tab is already open (never auto-open one).
  browser.alarms.create("poshmark-sync", { periodInMinutes: 360 });
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "poshmark-sync") return;
    if (!(await getDeviceToken())) return;
    const tabs = await browser.tabs.query({ url: "*://*.poshmark.com/*" });
    const tabId = tabs[0]?.id;
    if (tabId != null) {
      browser.tabs.sendMessage(tabId, { type: "SYNC_POSHMARK" }).catch(() => {});
    }
  });
});

async function errText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    return `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function handlePair(code: string, label?: string): Promise<PairResponse> {
  const res = await fetch(`${API_BASE}/api/extension/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ code, ...(label ? { label } : {}) }),
  });
  if (!res.ok) return { ok: false, error: await errText(res) };
  const data = (await res.json()) as { token?: string };
  if (!data.token) return { ok: false, error: "No token returned" };
  await setDeviceToken(data.token);
  return { ok: true };
}

async function handleSnapshot(snapshot: ExtensionSnapshot): Promise<SyncResponse> {
  const token = await getDeviceToken();
  if (!token) return { ok: false, error: "Not paired" };
  console.log(`[inv-ext] POST ${snapshot.listings.length} listings -> ${API_BASE}`);
  const res = await fetch(`${API_BASE}/api/extension/poshmark/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    credentials: "omit",
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const error = await errText(res);
    console.warn("[inv-ext] ingest failed", res.status, error);
    return { ok: false, error };
  }
  const data = (await res.json()) as { importedOrUpdated?: number; pruned?: number };
  console.log("[inv-ext] ingest ok", data);
  return { ok: true, imported: data.importedOrUpdated, pruned: data.pruned };
}

async function handleStatus(): Promise<StatusResponse> {
  const token = await getDeviceToken();
  if (!token) return { ok: true, paired: false };
  try {
    const res = await fetch(`${API_BASE}/api/extension/status`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (res.status === 401) return { ok: true, paired: false };
    if (!res.ok) return { ok: false, paired: true, error: await errText(res) };
    const data = (await res.json()) as {
      poshmark?: { username: string | null; connectedAt?: string } | null;
    };
    return { ok: true, paired: true, poshmark: data.poshmark ?? null };
  } catch (e) {
    return { ok: false, paired: true, error: e instanceof Error ? e.message : String(e) };
  }
}
