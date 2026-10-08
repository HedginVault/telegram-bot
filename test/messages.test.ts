import { describe, expect, it } from "vitest";
import { fitMessage, holdingsMessage, quoteMessage, strategiesMessage, vaultsMessage } from "../src/messages";
import { holdings, quote, strategies, vaultSummary } from "./fixtures";

describe("messages", () => {
  it("numbers vaults and shows full copyable addresses", () => {
    expect(vaultsMessage([vaultSummary])).toBe(
      "1. Demo (normal)\nVau1t1111111111111111111111111111111111111111\nTVL 1.5 USDC",
    );
    expect(vaultsMessage([])).toBe("This API key has no vaults in scope.");
  });

  it("renders holdings and warns that a partial view is not zero", () => {
    expect(holdingsMessage(vaultSummary, holdings)).toBe(
      [
        "Demo holdings",
        "Live value: 2.5 USDC ($2.5)",
        "Last NAV: 2.4 USDC (live vs NAV 4.17%)",
        "Partial view: no price for MYSTERY. Missing value is not zero.",
        "",
        "USDC: 1 ($1, 40.00%)",
        "SOL: 0.01 ($1.5, 60.00%)",
      ].join("\n"),
    );
  });

  it("renders every strategy kind", () => {
    expect(strategiesMessage(vaultSummary, strategies)).toBe(
      [
        "Demo strategies",
        "",
        "Swap: 0.01 SOL",
        "Meteora DLMM SOL/USDC (position Pos1…1111)",
        "  Range 140 to 160, now 150",
        "  Holds 0.5 SOL + 75 USDC",
        "Phoenix perps: equity 12.345678 USDC, leverage n/a",
        "dlmm strategy Stra…4444 could not be read: position account missing",
      ].join("\n"),
    );
    expect(strategiesMessage(vaultSummary, [])).toBe("Demo has no open strategies.");
  });

  it("labels quote amounts as base units", () => {
    expect(quoteMessage(quote)).toContain("Jupiter quote (base units)\nIn: 1000000\nOut: 6666666");
    expect(quoteMessage(quote)).toContain("Route: Meteora DLMM > Whirlpool");
  });

  it("trims messages to Telegram's limit", () => {
    const fitted = fitMessage("x".repeat(5000));
    expect(fitted).toHaveLength(4096);
    expect(fitted.endsWith("… (truncated)")).toBe(true);
    expect(fitMessage("short")).toBe("short");
  });
});
