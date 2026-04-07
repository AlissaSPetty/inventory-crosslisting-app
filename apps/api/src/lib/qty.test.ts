import { describe, expect, it } from "vitest";
import { applySaleToCanonical, quantityToApplyOnOtherListings } from "./qty.js";

describe("applySaleToCanonical", () => {
  it("decrements and detects depletion", () => {
    expect(applySaleToCanonical(5, 2)).toEqual({ next: 3, depleted: false });
    expect(applySaleToCanonical(2, 2)).toEqual({ next: 0, depleted: true });
  });
});

describe("quantityToApplyOnOtherListings", () => {
  it("caps by listed quantity", () => {
    expect(quantityToApplyOnOtherListings(3, 5)).toBe(3);
    expect(quantityToApplyOnOtherListings(10, 2)).toBe(2);
  });
});
