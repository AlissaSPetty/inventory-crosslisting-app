import { defineConfig } from "wxt";

// WXT config — https://wxt.dev
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Inventory Cross-listing — Poshmark",
    description: "Track your Poshmark closet inventory in the Inventory Cross-listing app.",
    permissions: ["storage", "alarms", "tabs"],
    // Poshmark (read the user's closet) + the app API (push snapshots). Add the
    // production API origin here before shipping a production build.
    host_permissions: [
      "*://*.poshmark.com/*",
      "http://localhost:3001/*",
      "http://127.0.0.1:3001/*",
    ],
  },
});
