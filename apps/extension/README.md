# @inv/extension — Poshmark inventory tracker (MV3, WXT)

Poshmark has no public API, so this browser extension reads the user's closet in
their own logged-in session and pushes it to `@inv/api`, which tracks it as
`platform_listings`. Read-only for now (no writes back to Poshmark).

## Develop

```bash
pnpm --filter @inv/extension dev      # launches Chrome with the extension loaded (HMR)
pnpm --filter @inv/extension build    # production build → .output/chrome-mv3
```

To load a production build manually: `chrome://extensions` → enable Developer
mode → **Load unpacked** → select `apps/extension/.output/chrome-mv3`.

### API base URL

Baked at build time. Defaults to `http://localhost:3001`. Override per build:

```bash
WXT_API_BASE=https://api.yourapp.com pnpm --filter @inv/extension build
```

The chosen origin must also be listed in `host_permissions` (`wxt.config.ts`).

## How it fits together

- **popup** (`entrypoints/popup`) — paste the pairing code from the app's
  Integrations page; "Sync now".
- **background** (`entrypoints/background.ts`) — holds the device token
  (`chrome.storage.local`, never exposed to the content script), calls the API,
  runs a gentle `chrome.alarms` sync only when a Poshmark tab is already open.
- **content script** (`entrypoints/poshmark.content.ts`) — scrapes the closet
  and hands a snapshot to the background worker.

## ⚠️ Before trusting production data: verify the Poshmark scraper

`utils/poshmark.ts` reads Poshmark's **undocumented** `vm-rest` JSON endpoints
(with a DOM fallback). Every fragile field/selector is marked `VERIFY:`. Open a
logged-in Poshmark closet, watch the Network tab, and confirm the endpoint path,
query envelope, cursor field, and post shape before relying on it. The raw post
payload is stored in each listing's `metadata` so a shape change is recoverable.

Automating a logged-in session is against Poshmark's ToS and can rate-limit or
flag the user's own account — keep syncs gentle (manual / when already on
Poshmark), honor 429s, and never auto-open tabs.
