import { describe, expect, it } from "vitest";
import { compactDecimal, compactUnits, compactUsd, feePct, formatBaseUnits, shortAddress } from "../src/format";

describe("formatBaseUnits", () => {
  it("formats amounts beyond Number precision exactly", () => {
    expect(formatBaseUnits("123456789012345678901", 6)).toBe("123,456,789,012,345.678901");
  });
  it("trims trailing fractional zeros", () => {
    expect(formatBaseUnits("1500000", 6)).toBe("1.5");
    expect(formatBaseUnits("2000000", 6)).toBe("2");
  });
  it("keeps leading fractional zeros", () => {
    expect(formatBaseUnits("1", 6)).toBe("0.000001");
  });
  it("handles zero decimals", () => {
    expect(formatBaseUnits("1234", 0)).toBe("1,234");
  });
});

describe("shortAddress", () => {
  it("abbreviates long addresses", () => {
    expect(shortAddress("So11111111111111111111111111111111111111112")).toBe("So11…1112");
  });
});

describe("compactUnits", () => {
  it("keeps at most 4 fraction digits once the whole part is non-zero, truncating", () => {
    expect(compactUnits("10101799", 6)).toBe("10.1017");
    expect(compactUnits("1234567890000", 6)).toBe("1,234,567.89");
    expect(compactUnits("2000000", 6)).toBe("2");
  });
  it("keeps 4 significant digits below one", () => {
    expect(compactUnits("51673", 9)).toBe("0.00005167");
    expect(compactUnits("1", 6)).toBe("0.000001");
    expect(compactUnits("500000", 6)).toBe("0.5");
  });
  it("handles zero, zero decimals, negatives, and values beyond Number precision", () => {
    expect(compactUnits("0", 6)).toBe("0");
    expect(compactUnits("1234", 0)).toBe("1,234");
    expect(compactUnits("-1500000", 6)).toBe("-1.5");
    expect(compactUnits("123456789012345678901", 6)).toBe("123,456,789,012,345.6789");
  });
});

describe("compactDecimal", () => {
  it("trims API price strings the same way and leaves odd ones alone", () => {
    expect(compactDecimal("0.44703912")).toBe("0.447");
    expect(compactDecimal("147.91573")).toBe("147.9157");
    expect(compactDecimal("150")).toBe("150");
    expect(compactDecimal("1.5e-7")).toBe("1.5e-7");
  });
});

describe("compactUsd", () => {
  it("abbreviates thousands and millions", () => {
    expect(compactUsd(1_250_000)).toBe("$1.25M");
    expect(compactUsd(340_000)).toBe("$340K");
    expect(compactUsd(3400)).toBe("$3.4K");
    expect(compactUsd(12.5)).toBe("$12.50");
    expect(compactUsd(2_000_000_000)).toBe("$2B");
    expect(compactUsd(null)).toBe("n/a");
  });
});

describe("feePct", () => {
  it("strips trailing zeros", () => {
    expect(feePct(0.2)).toBe("0.2%");
    expect(feePct(0.04)).toBe("0.04%");
    expect(feePct(1)).toBe("1%");
  });
});
