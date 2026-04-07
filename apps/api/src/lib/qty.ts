/** Pure helpers for quantity propagation — unit-tested. */

export function applySaleToCanonical(
  current: number,
  soldQty: number
): { next: number; depleted: boolean } {
  const next = Math.max(0, current - soldQty);
  return { next, depleted: next === 0 };
}

export function quantityToApplyOnOtherListings(
  canonicalRemaining: number,
  otherListed: number
): number {
  return Math.min(otherListed, Math.max(0, canonicalRemaining));
}
