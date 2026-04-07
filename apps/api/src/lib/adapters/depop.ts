import type { PlatformAdapter } from "./types.js";

export function createDepopAdapter(): PlatformAdapter {
  return {
    platform: "depop",
    async fetchActiveListings() {
      return {
        ok: false,
        code: "blocked",
        message: "Depop partner API access required — connect when credentials are available",
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
        code: "blocked",
        message: "Depop blocked until partner credentials",
      };
    },
    async deleteListing() {
      return {
        ok: false,
        code: "blocked",
        message: "Depop blocked until partner credentials",
      };
    },
  };
}
