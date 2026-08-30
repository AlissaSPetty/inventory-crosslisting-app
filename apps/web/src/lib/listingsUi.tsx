/**
 * Shared visual vocabulary for the app: per-channel identity (monograms + brand
 * colors) and the semantic status color system used across the Dashboard and
 * Inventory. Colors extend the app's existing slate/blue tokens.
 */
import type { CSSProperties } from "react";

export type ChannelMeta = { label: string; color: string; letter: string };

/** Marketplace identity. `color` is a brand-representative accent, `letter` the monogram. */
export const PLATFORM_META: Record<string, ChannelMeta> = {
  ebay: { label: "eBay", color: "#1668e3", letter: "e" },
  shopify: { label: "Shopify", color: "#5e8e3e", letter: "S" },
  depop: { label: "Depop", color: "#ff2300", letter: "D" },
  poshmark: { label: "Poshmark", color: "#7b1f3f", letter: "P" },
  mercari: { label: "Mercari", color: "#e8532b", letter: "M" },
};

/** Display order shared by the Channels panel and draft/listing groupings. */
export const PLATFORM_ORDER = ["ebay", "shopify", "poshmark", "mercari", "depop"] as const;

export function platformLabel(platform: string): string {
  return PLATFORM_META[platform]?.label ?? platform;
}

export function ChannelMonogram({ platform, size = 26 }: { platform: string; size?: number }) {
  const meta = PLATFORM_META[platform];
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.27),
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontWeight: 700,
    fontSize: Math.round(size * 0.46),
    lineHeight: 1,
    flex: "none",
    background: meta?.color ?? "#94a3b8",
  };
  return (
    <span style={style} aria-hidden>
      {meta?.letter ?? (platform[0]?.toUpperCase() || "?")}
    </span>
  );
}

export type StatusKey = "inprogress" | "ready" | "live" | "sold" | "failed" | "ended";

export const STATUS_META: Record<StatusKey, { label: string; fg: string; soft: string; dot: string }> = {
  inprogress: { label: "In progress", fg: "#b45309", soft: "#fef3c7", dot: "#d97706" },
  ready: { label: "Ready", fg: "#1d4ed8", soft: "#dbeafe", dot: "#2563eb" },
  live: { label: "Live", fg: "#15803d", soft: "#dcfce7", dot: "#16a34a" },
  sold: { label: "Sold", fg: "#6d28d9", soft: "#ede9fe", dot: "#7c3aed" },
  failed: { label: "Failed", fg: "#b91c1c", soft: "#fee2e2", dot: "#dc2626" },
  ended: { label: "Ended", fg: "#475569", soft: "#f1f5f9", dot: "#94a3b8" },
};

/** Status is never color-alone: every pill carries its label plus a dot/icon. */
export function StatusPill({ status, label }: { status: StatusKey; label?: string }) {
  const m = STATUS_META[status];
  return (
    <span className="status-pill" style={{ background: m.soft, color: m.fg }}>
      {status === "inprogress" ? (
        <span className="status-spinner" aria-hidden />
      ) : status === "failed" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <span className="status-dot" style={{ background: m.dot }} aria-hidden />
      )}
      {label ?? m.label}
    </span>
  );
}
