import { describe, expect, it } from "vitest";
import type { Strategy, VaultSummary } from "@hedginvault/sdk";
import {
  HELP_MESSAGE,
  errorMessage,
  escapeHtml,
  fitMessage,
  holdingsMessage,
  confirmMessage,
  lpFormMessage,
  strategiesMessage,
  swapFormMessage,
  swapQuoteMessage,
  vaultMessage,
  vaultsMessage,
} from "../src/messages";
import type { LpForm, SwapForm } from "../src/forms";
import { VAULT, holdings, quote, strategies, vaultSummary } from "./fixtures";
import { assertTelegramHtml } from "./telegram-html";

const HOSTILE = `<b>&"x"</b>`;
const hostileVault: VaultSummary = { ...vaultSummary, name: HOSTILE, depositSymbol: HOSTILE, status: HOSTILE };
const hostileStrategies: Strategy[] = [
  { type: "jupiter", address: "S1", symbol: HOSTILE, decimals: 0, vaultBalance: "1" },
  { type: "unreadable", address: HOSTILE, protocol: HOSTILE, reason: HOSTILE },
];

const hostileToken = { mint: "M", symbol: HOSTILE, decimals: 6 };
const hostilePool = { lbPair: "P", tokenX: hostileToken, tokenY: hostileToken, binStep: 10, activeBinId: 1, activePrice: HOSTILE };
const hostilePicked = { ...hostileToken, mint: HOSTILE, pasted: true, verified: false };
const hostileSwap: SwapForm = { kind: "swap", vault: VAULT, deposit: hostileToken, side: "sell", token: hostilePicked, amount: { kind: "share", bps: 2500 }, slippageBps: 50, held: [hostilePicked] };
const hostileLp: LpForm = { kind: "lp", mode: "open", vault: VAULT, deposit: hostileToken, pool: hostilePool, shape: "bidAsk", minPrice: 1, maxPrice: 2, amountX: { kind: "exact", baseUnits: "1" } };
const hostileLiquidity = { tokenX: hostileToken, tokenY: hostileToken, amountX: "1", amountY: "2", shape: "curve" as const };

describe("messages", () => {
  it("lists vaults with a tap-to-copy address and status in words", () => {
    expect(vaultsMessage([vaultSummary])).toBe(
      [
        "🏦 <b>Your vaults</b> (1)",
        "",
        "<b>1. Demo</b> · 🟢 normal",
        `<code>${VAULT}</code>`,
        `TVL <b>1.5 USDC</b> · <a href="https://solscan.io/account/${VAULT}">Solscan</a>`,
      ].join("\n"),
    );
    expect(vaultsMessage([])).toBe("🏦 This API key has no vaults in scope.");
  });

  it("renders holdings and warns that a partial view is not zero", () => {
    expect(holdingsMessage(vaultSummary, holdings)).toBe(
      [
        "📊 <b>Demo</b> · holdings",
        "",
        "Live value <b>2.5 USDC</b> ($2.50)",
        "Last NAV 2.4 USDC · <i>live vs NAV +4.17%</i>",
        "<blockquote>⚠️ Partial view: no price for MYSTERY. Missing value is not zero.</blockquote>",
        "",
        "<b>Tokens</b>",
        "• <b>USDC</b> 1 · $1.00 · 40.00%",
        "• <b>SOL</b> 0.01 · $1.50 · 60.00%",
      ].join("\n"),
    );
  });

  it("renders every strategy kind", () => {
    expect(strategiesMessage(vaultSummary, strategies)).toBe(
      [
        "🧩 <b>Demo</b> · strategies (4)",
        "",
        "<b>Swap</b> · SOL",
        "Balance 0.01 SOL",
        "",
        "<b>Meteora DLMM</b> · SOL/USDC",
        "Position <code>Pos1111111111111111111111111111111111111111</code>",
        "Range 140 to 160 · now <b>150</b>",
        "Holds 0.5 SOL + 75 USDC",
        "",
        "<b>Phoenix perps</b>",
        "Equity 12.345678 USDC · leverage n/a",
        "",
        "⚠️ <b>Unreadable dlmm strategy</b>",
        "<code>Strat4444444444444444444444444444444444444</code>",
        "<i>position account missing</i>",
      ].join("\n"),
    );
    expect(strategiesMessage(vaultSummary, [])).toBe("🧩 <b>Demo</b> · strategies\n\nNo open strategies.");
  });

  it("escapes API-provided text", () => {
    expect(escapeHtml(HOSTILE)).toBe(`&lt;b&gt;&amp;"x"&lt;/b&gt;`);
    expect(errorMessage("API error 400 (Validation)", "amount <must> be & valid")).toBe(
      "❌ <b>API error 400 (Validation)</b>\namount &lt;must&gt; be &amp; valid",
    );
  });

  it("has an HTML checker that rejects broken markup", () => {
    expect(() => assertTelegramHtml("<b>open\nclose</b>")).toThrow(/unclosed/);
    expect(() => assertTelegramHtml("<u>x</u>")).toThrow(/not allowed/);
    expect(() => assertTelegramHtml("a & b")).toThrow(/ampersand/);
    expect(() => assertTelegramHtml("1 < 2")).toThrow(/angle bracket/);
  });

  it("produces valid Telegram HTML even for hostile API values", () => {
    const rendered = [
      HELP_MESSAGE,
      vaultsMessage([vaultSummary, hostileVault]),
      holdingsMessage(hostileVault, { ...holdings, unpriced: [HOSTILE] }),
      strategiesMessage(hostileVault, [...strategies, ...hostileStrategies]),
      errorMessage(HOSTILE, HOSTILE),
      vaultMessage(hostileVault),
      swapFormMessage(hostileSwap, "5"),
      swapFormMessage({ ...hostileSwap, token: undefined, amount: undefined }, undefined),
      swapQuoteMessage(hostileSwap, { input: hostileToken, output: hostileToken }, "1", { ...quote, priceImpactPct: HOSTILE, routeLabels: [HOSTILE] }),
      lpFormMessage(hostileLp, "range error " + HOSTILE, { x: "1", y: "2" }),
      lpFormMessage({ ...hostileLp, pool: undefined, poolChoices: [{ address: "P", label: HOSTILE }] }, undefined, undefined),
      lpFormMessage(hostileLp, { lowerBinId: 0, upperBinId: 5, binCount: 5, sides: "x", lowPrice: 1, highPrice: 2 }, undefined),
      confirmMessage(hostileVault, { kind: "dlmmOpen", vault: VAULT, lbPair: "P", pairLabel: HOSTILE, lowerBinId: 0, upperBinId: 150, priceRange: { low: HOSTILE, high: HOSTILE }, liquidity: hostileLiquidity }),
      confirmMessage(hostileVault, { kind: "swap", vault: VAULT, input: hostileToken, output: hostileToken, amountBaseUnits: "1", slippageBps: 50, unverified: true }, quote),
    ];
    for (const html of rendered) {
      expect(() => assertTelegramHtml(html)).not.toThrow();
      expect(html).not.toContain(HOSTILE);
    }
  });

  it("trims long messages at a line break so tags stay closed", () => {
    const html = Array.from({ length: 400 }, (_, i) => `<b>row ${i}</b> some text`).join("\n");
    const fitted = fitMessage(html);
    expect(fitted.length).toBeLessThanOrEqual(4096);
    expect(fitted.endsWith("\n<i>… truncated</i>")).toBe(true);
    expect(() => assertTelegramHtml(fitted)).not.toThrow();
    expect(fitMessage("short")).toBe("short");
  });
});
