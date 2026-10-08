import { describe, expect, it } from "vitest";
import { parseAmountInput, parsePrice, parseSlippage, resolveAmount } from "../src/forms";

describe("parseAmountInput", () => {
  it("reads exact display amounts with the token's decimals", () => {
    expect(parseAmountInput("1.5", 6)).toEqual({ kind: "exact", baseUnits: "1500000" });
    expect(parseAmountInput(" 1,000 ", 9)).toEqual({ kind: "exact", baseUnits: "1000000000000" });
  });
  it("reads shares", () => {
    expect(parseAmountInput("25%", 6)).toEqual({ kind: "share", bps: 2500 });
    expect(parseAmountInput("0.5 %", 6)).toEqual({ kind: "share", bps: 50 });
    expect(parseAmountInput("MAX", 6)).toEqual({ kind: "share", bps: 10_000 });
  });
  it("explains bad input", () => {
    expect(() => parseAmountInput("0", 6)).toThrow("The amount must be more than zero.");
    expect(() => parseAmountInput("150%", 6)).toThrow("A percentage must be between 0.01% and 100%.");
    expect(() => parseAmountInput("1.0000001", 6)).toThrow(/has more. Try "1.5", "25%", or "max"./);
    expect(() => parseAmountInput("lots", 6)).toThrow(/is not a number/);
  });
});

describe("resolveAmount", () => {
  it("takes shares of the balance in base units", () => {
    expect(resolveAmount({ kind: "share", bps: 2500 }, "1000001")).toBe("250000");
    expect(resolveAmount({ kind: "share", bps: 10_000 }, "1000001")).toBe("1000001");
  });
  it("refuses exact amounts above the balance", () => {
    expect(resolveAmount({ kind: "exact", baseUnits: "5" }, "5")).toBe("5");
    expect(() => resolveAmount({ kind: "exact", baseUnits: "6" }, "5")).toThrow("That is more than the vault holds.");
  });
});

describe("parseSlippage", () => {
  it("accepts percent and bps", () => {
    expect(parseSlippage("0.8")).toBe(80);
    expect(parseSlippage("1.25%")).toBe(125);
    expect(parseSlippage("80 bps")).toBe(80);
  });
  it("enforces the protocol cap and sane values", () => {
    expect(() => parseSlippage("5")).toThrow("The protocol caps slippage at 3%.");
    expect(() => parseSlippage("0")).toThrow(/Send slippage/);
    expect(() => parseSlippage("abc")).toThrow(/Send slippage/);
  });
});

describe("parsePrice", () => {
  it("parses positive prices", () => {
    expect(parsePrice("1,234.5")).toBe(1234.5);
    expect(parsePrice("0.00001234")).toBe(0.00001234);
    expect(() => parsePrice("-1")).toThrow(/positive price/);
  });
});
