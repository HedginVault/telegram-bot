import { describe, expect, it } from "vitest";
import { type PendingAction, toActionRequest } from "../src/actions";
import {
  amountsInRange,
  parseAmountInput,
  parseDecimal,
  parseFeeBps,
  parseLimit,
  parseOrderSlippage,
  parsePrice,
  parseSlippage,
  parseVaultName,
  quickPickRange,
  resolveAmount,
  vaultChanges,
} from "../src/forms";
import { POOL, USDC, VAULT } from "./fixtures";

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

describe("parseFeeBps", () => {
  it("reads percents into basis points without floating point", () => {
    expect(parseFeeBps("10")).toBe(1000);
    expect(parseFeeBps("12.5%")).toBe(1250);
    expect(parseFeeBps("0.07")).toBe(7);
    expect(parseFeeBps("0")).toBe(0);
    expect(parseFeeBps("100")).toBe(10_000);
  });
  it("rejects fees out of range or too precise", () => {
    expect(() => parseFeeBps("100.01")).toThrow("A fee must be between 0% and 100%.");
    expect(() => parseFeeBps("0.125")).toThrow(/at most 2 decimals/);
    expect(() => parseFeeBps("-1")).toThrow(/Send a fee as a percent/);
  });
});

describe("parseDecimal", () => {
  it("keeps sizes and limit prices as decimal strings", () => {
    expect(parseDecimal("0.5", "size")).toBe("0.5");
    expect(parseDecimal("65,000.25", "price")).toBe("65000.25");
    expect(parseDecimal("007.5", "price")).toBe("7.5");
    expect(parseDecimal("0.000000000001", "size")).toBe("0.000000000001");
  });
  it("rejects zero, negatives, and more than 12 decimals", () => {
    const message = 'Send the price as a positive number like "142.5", with at most 12 decimals.';
    expect(() => parseDecimal("0", "price")).toThrow(message);
    expect(() => parseDecimal("-1", "price")).toThrow(message);
    expect(() => parseDecimal("1.0000000000001", "price")).toThrow(message);
    expect(() => parseDecimal("1.", "price")).toThrow(message);
  });
});

describe("parseOrderSlippage", () => {
  it("allows up to 20% for Phoenix market orders", () => {
    expect(parseOrderSlippage("20")).toBe(2000);
    expect(parseOrderSlippage("1bps")).toBe(1);
    expect(() => parseOrderSlippage("20.01")).toThrow("Phoenix market orders allow at most 20% slippage.");
    expect(() => parseOrderSlippage("0")).toThrow(/Send slippage/);
  });
});

describe("parseVaultName", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(parseVaultName("  Alpha  ")).toBe("Alpha");
    expect(parseVaultName("a".repeat(32))).toBe("a".repeat(32));
    expect(() => parseVaultName("a".repeat(33))).toThrow("That name is 33 bytes; the limit is 32. Use a shorter name.");
    expect(() => parseVaultName("🚀".repeat(9))).toThrow("That name is 36 bytes; the limit is 32. Use a shorter name.");
    expect(() => parseVaultName("   ")).toThrow("Send a name for the vault.");
  });
});

describe("parseLimit", () => {
  it("reads token units into base units", () => {
    expect(parseLimit("1,000.5", 6)).toBe("1000500000");
    expect(parseLimit("none", 6, true)).toBe("18446744073709551615");
    expect(parseLimit("0", 6, true)).toBe("0");
  });
  it("rejects a zero minimum, a cap above u64, and none where a cap is not asked", () => {
    expect(() => parseLimit("0", 6)).toThrow("This minimum must be more than zero.");
    expect(() => parseLimit("18446744073709.551616", 6, true)).toThrow("That amount is too large.");
    expect(() => parseLimit("none", 6)).toThrow(/is not a number/);
  });
});

describe("vaultChanges", () => {
  const current = { performanceFeeBps: 1000, managementFeeBps: 200, depositCap: "1", minDeposit: "2", minWithdrawalShares: "3" };
  it("keeps only the fields that differ", () => {
    expect(vaultChanges(current, current)).toEqual({});
    expect(vaultChanges({ ...current, managementFeeBps: 0, minDeposit: "5" }, current)).toEqual({ managementFeeBps: 0, minDeposit: "5" });
  });
});

describe("quickPickRange", () => {
  const position = { lowerBinId: -110, upperBinId: -90 };
  it.each([
    ["top", 25, { lowerBinId: -95, upperBinId: -90 }],
    ["top", 50, { lowerBinId: -100, upperBinId: -90 }],
    ["bottom", 25, { lowerBinId: -110, upperBinId: -105 }],
    ["bottom", 50, { lowerBinId: -110, upperBinId: -100 }],
  ] as const)("takes the %s %i%% of a 21-bin position, rounding the count up", (end, pct, range) => {
    expect(quickPickRange(position, end, pct)).toEqual(range);
  });
  it("takes at least one bin", () => {
    expect(quickPickRange({ lowerBinId: 7, upperBinId: 7 }, "top", 25)).toEqual({ lowerBinId: 7, upperBinId: 7 });
    expect(quickPickRange({ lowerBinId: 0, upperBinId: 2 }, "bottom", 25)).toEqual({ lowerBinId: 0, upperBinId: 0 });
  });
});

describe("amountsInRange", () => {
  const bins = [
    { binId: 1, amountX: "3", amountY: "5" },
    { binId: 2, amountX: "3", amountY: "0" },
    { binId: 9, amountX: "100", amountY: "100" },
  ];
  it("sums the bins in range, flooring each bin's share", () => {
    expect(amountsInRange(bins, { lowerBinId: 1, upperBinId: 2 }, 5000)).toEqual({ amountX: 2n, amountY: 2n });
    expect(amountsInRange(bins, { lowerBinId: 1, upperBinId: 9 }, 10_000)).toEqual({ amountX: 106n, amountY: 105n });
    expect(amountsInRange(bins, { lowerBinId: 3, upperBinId: 8 }, 10_000)).toEqual({ amountX: 0n, amountY: 0n });
  });
});

describe("toActionRequest", () => {
  const usdc = { mint: USDC, symbol: "USDC", decimals: 6 };
  const cases: [Exclude<PendingAction, { kind: "phoenixOnboard" }>, unknown][] = [
    [
      { kind: "dlmmInit", vault: VAULT, lbPair: POOL, pairLabel: "SOL/USDC", lowerBinId: -5, upperBinId: 5, priceRange: { low: "1", high: "2" } },
      { action: "dlmm/initialize", vault: VAULT, lbPair: POOL, lowerBinId: -5, upperBinId: 5 },
    ],
    [{ kind: "dlmmClose", vault: VAULT, position: "P", pairLabel: "SOL/USDC" }, { action: "dlmm/close", vault: VAULT, position: "P" }],
    [
      {
        kind: "dlmmRemove",
        vault: VAULT,
        position: "P",
        pairLabel: "SOL/USDC",
        bps: 2500,
        bins: { label: "top 25% of bins", lowerBinId: -104, upperBinId: -96, priceRange: { low: "1", high: "2" }, tokenX: usdc, tokenY: usdc, amountXBaseUnits: "1", amountYBaseUnits: "2" },
      },
      { action: "dlmm/remove", vault: VAULT, position: "P", bpsToRemove: 2500, lowerBinId: -104, upperBinId: -96 },
    ],
    [{ kind: "jupiterInit", vault: VAULT, token: { mint: "M", symbol: "M", decimals: 6 }, verified: null }, { action: "jupiter/initialize", vault: VAULT, targetMint: "M" }],
    [{ kind: "phoenixInit", vault: VAULT }, { action: "phoenix/initialize", vault: VAULT }],
    [{ kind: "phoenixDeposit", vault: VAULT, amountBaseUnits: "7" }, { action: "phoenix/deposit", vault: VAULT, amount: "7" }],
    [{ kind: "phoenixWithdraw", vault: VAULT, amountBaseUnits: "8" }, { action: "phoenix/withdraw", vault: VAULT, amount: "8" }],
    [
      { kind: "phoenixOrder", vault: VAULT, order: { symbol: "SOL", side: "long", size: "1", reduceOnly: false, order: { type: "market", slippageBps: 100 } } },
      { action: "phoenix/order", vault: VAULT, symbol: "SOL", side: "long", size: "1", reduceOnly: false, order: { type: "market", slippageBps: 100 } },
    ],
    [{ kind: "phoenixCancel", vault: VAULT, symbol: "SOL" }, { action: "phoenix/cancel", vault: VAULT, symbol: "SOL", orders: "all" }],
    [{ kind: "phoenixSweep", vault: VAULT }, { action: "phoenix/sweep", vault: VAULT }],
    [
      { kind: "vaultCreate", name: "A", deposit: usdc, performanceFeeBps: 1, managementFeeBps: 2, depositCap: "3", minDeposit: "4", minWithdrawalShares: "5" },
      { action: "vault/initialize", name: "A", depositMint: USDC, performanceFeeBps: 1, managementFeeBps: 2, depositCap: "3", minDeposit: "4", minWithdrawalShares: "5" },
    ],
    [{ kind: "vaultUpdate", vault: VAULT, deposit: usdc, changes: { status: "reduceOnly", depositPaused: true } }, { action: "vault/update", vault: VAULT, status: "reduceOnly", depositPaused: true }],
    [{ kind: "vaultClaimFee", vault: VAULT }, { action: "vault/claim-fee", vault: VAULT }],
    [{ kind: "vaultClose", vault: VAULT }, { action: "vault/close", vault: VAULT }],
  ];
  it.each(cases)("maps %o", (action, request) => {
    expect(toActionRequest(action)).toEqual(request);
  });
});
