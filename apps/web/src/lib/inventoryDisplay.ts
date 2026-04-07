/**
 * Placeholder title used when creating inventory before the user or AI sets a real name
 * (`NewDraftPage` → `POST /api/inventory`).
 */
const PLACEHOLDER_INVENTORY_TITLE = /^new\s*item$/i;

export function isPlaceholderInventoryTitle(title: string | null | undefined): boolean {
  if (title == null || typeof title !== "string") return true;
  const t = title.trim();
  if (!t) return true;
  return PLACEHOLDER_INVENTORY_TITLE.test(t);
}

/**
 * Prefer the canonical inventory `title` when it is user- or system-meaningful; otherwise use `fallback`.
 */
export function inventoryItemDisplayName(
  inventoryTitle: string | null | undefined,
  fallback: string | null | undefined
): string {
  if (!isPlaceholderInventoryTitle(inventoryTitle)) return inventoryTitle!.trim();
  const f = typeof fallback === "string" ? fallback.trim() : "";
  return f || "—";
}
