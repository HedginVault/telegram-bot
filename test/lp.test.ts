import { describe, expect, it } from "vitest";
import { binPrice, rangePrices, rangeSpanPct, singleSidedRange } from "../src/lp";

describe("singleSidedRange", () => {
  it("puts token X at and above the active bin", () => {
    expect(singleSidedRange(-100, 10, true)).toEqual({ lowerBinId: -100, upperBinId: -90 });
  });
  it("puts token Y at and below the active bin", () => {
    expect(singleSidedRange(-100, 10, false)).toEqual({ lowerBinId: -109, upperBinId: -99 });
  });
  it("covers exactly `width` bins either way", () => {
    for (const depositIsX of [true, false]) {
      const { lowerBinId, upperBinId } = singleSidedRange(5, 69, depositIsX);
      expect(upperBinId - lowerBinId).toBe(69);
    }
  });
});

describe("prices", () => {
  it("compounds bin step per bin", () => {
    expect(binPrice(100, 0, 100, 0)).toBe(100);
    expect(binPrice(100, 0, 100, 2)).toBeCloseTo(102.01, 10);
    expect(binPrice(100, 0, 100, -1)).toBeCloseTo(99.0099, 4);
  });
  it("labels the inclusive price range of a Y-side range", () => {
    expect(rangePrices(150, 0, 10, singleSidedRange(0, 10, false))).toEqual({ low: "148.6567", high: "150" });
  });
  it("describes span as percent from the active price", () => {
    expect(rangeSpanPct(10, 10)).toBe("0.9%");
    expect(rangeSpanPct(100, 69)).toBe("96.7%");
  });
});
