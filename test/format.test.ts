import { describe, expect, it } from "vitest";
import { formatBaseUnits, shortAddress } from "../src/format";

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
