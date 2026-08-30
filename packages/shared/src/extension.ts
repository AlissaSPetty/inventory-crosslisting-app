import { z } from "zod";

/**
 * Wire contract between the browser extension and `@inv/api`. Single source of
 * truth for both sides — the extension validates its normalized output before
 * pushing, and the API validates the request body against the same schema.
 *
 * The extension reads a user's marketplace closet in their own logged-in
 * session (no public API exists for Poshmark/Mercari), normalizes each listing
 * to `SnapshotListing`, and POSTs an `ExtensionSnapshot`.
 */

/** Platforms reachable only via the extension (no server-side API adapter). */
export const EXTENSION_PLATFORMS = ["poshmark", "mercari"] as const;
export type ExtensionPlatform = (typeof EXTENSION_PLATFORMS)[number];

/**
 * Normalized listing state as reported by the marketplace closet.
 * - `available` — live and purchasable (maps to `pending_link`/`active`).
 * - `reserved`  — live but temporarily held (treated as live).
 * - `sold`      — sold; kept for history, never pruned (maps to `sold`).
 */
export const SNAPSHOT_LISTING_STATUSES = ["available", "reserved", "sold"] as const;
export type SnapshotListingStatus = (typeof SNAPSHOT_LISTING_STATUSES)[number];

export const SnapshotListingSchema = z.object({
  /** Stable marketplace id for the listing (e.g. Poshmark post id). */
  externalListingId: z.string().min(1),
  title: z.string().min(1),
  /** Price in cents. `platform_listings` has no price column — stored in metadata. */
  priceCents: z.number().int().min(0).optional(),
  quantity: z.number().int().min(0).default(1),
  status: z.enum(SNAPSHOT_LISTING_STATUSES).default("available"),
  url: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  /** ISO 8601 when the listing went live, when known. */
  listedAt: z.string().optional(),
  /** Extra marketplace fields (brand, size, raw payload) preserved as-is. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SnapshotListing = z.infer<typeof SnapshotListingSchema>;

/** Hard cap so a runaway push can't be unbounded. */
export const SNAPSHOT_MAX_LISTINGS = 5000;

export const ExtensionSnapshotSchema = z.object({
  platform: z.enum(EXTENSION_PLATFORMS),
  /**
   * `true` only when the client fully drained the closet cursor. The server
   * prunes rows absent from the snapshot ONLY when complete — a partial push
   * (interrupted pagination) must never delete rows.
   */
  complete: z.boolean(),
  /** The connected marketplace account handle, when known. */
  username: z.string().optional(),
  listings: z.array(SnapshotListingSchema).max(SNAPSHOT_MAX_LISTINGS),
});
export type ExtensionSnapshot = z.infer<typeof ExtensionSnapshotSchema>;
