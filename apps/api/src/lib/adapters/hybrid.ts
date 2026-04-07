import type { PlatformAdapter } from "./types.js";

export function createHybridAdapter(platform: "poshmark" | "mercari"): PlatformAdapter {
  return {
    platform,
    async fetchActiveListings() {
      return {
        ok: false,
        code: "manual_required",
        message: "Add listing URL or ID manually in the dashboard",
      };
    },
    async setInventoryQuantity(
      _c: unknown,
      _id: string,
      _q: number,
      _ctx?: { shopDomain?: string }
    ) {
      void _c;
      void _id;
      void _q;
      void _ctx;
      return {
        ok: false,
        code: "manual_required",
        message: "Update quantity on the marketplace or use manual sync",
      };
    },
    async deleteListing() {
      return {
        ok: false,
        code: "manual_required",
        message: "Delete from the marketplace UI or confirm in dashboard checklist",
      };
    },
  };
}
