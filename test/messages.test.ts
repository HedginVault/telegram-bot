import { describe, expect, it } from "vitest";
import type { Strategy, VaultSummary } from "@hedginvault/sdk";
import type { PendingAction } from "../src/actions";
import {
  HELP_MESSAGE,
  errorHint,
  errorMessage,
  executionMessage,
  navHistoryMessage,
  orderFormMessage,
  phoenixMessage,
  phoenixTransferFormMessage,
  requestsMessage,
  settingsMessage,
  strategyHistoryMessage,
  trackFormMessage,
  vaultFormMessage,
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
import type { LpForm, OrderForm, SwapForm, VaultForm } from "../src/forms";
import { VAULT, holdings, navHistory, phoenixNone, phoenixReady, phoenixRegistered, quote, requestQueue, strategies, strategyHistory, vaultDetail, vaultSummary } from "./fixtures";
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
const hostileDetail = { ...vaultDetail, name: HOSTILE, depositSymbol: HOSTILE, pendingPerformanceFeeBps: 1, feeEffectiveTs: 1 };
const hostilePhoenix = {
  ...phoenixReady,
  traderAccount: HOSTILE,
  openOrders: [{ symbol: HOSTILE, side: "long" as const, price: HOSTILE, size: HOSTILE, priceInTicks: "1", orderSequenceNumber: "1", reduceOnly: true }],
  account: phoenixReady.account && { ...phoenixReady.account, riskState: HOSTILE, liquidationPrices: { [HOSTILE]: HOSTILE } },
};
const hostileOrder: OrderForm = {
  kind: "order",
  vault: VAULT,
  markets: [{ symbol: HOSTILE, markPrice: HOSTILE }],
  symbol: HOSTILE,
  side: "short",
  size: HOSTILE,
  type: "limit",
  slippageBps: 100,
  price: HOSTILE,
  postOnly: true,
  reduceOnly: true,
};
const hostileParams = { performanceFeeBps: 1, managementFeeBps: 2, depositCap: "18446744073709551615", minDeposit: "1", minWithdrawalShares: "1" };
const hostileVaultForm: VaultForm = { kind: "vault", name: HOSTILE, deposit: hostilePicked, params: hostileParams };
const hostileFlow = { mint: HOSTILE, symbol: HOSTILE, decimals: 6, contributed: "1", returned: "0", feesGross: "0", feesTreasury: "0", feesRetained: "0", realizedPnl: "-1" };
const hostileClosed = { strategy: HOSTILE, id: null, type: null, protocolAccount: null, openedTs: null, closedTs: 0, openSignature: null, closeSignature: HOSTILE, exact: false, tokens: [] };
const hostileActions: PendingAction[] = [
  { kind: "dlmmInit", vault: VAULT, lbPair: "P", pairLabel: HOSTILE, lowerBinId: 0, upperBinId: 5, priceRange: { low: HOSTILE, high: HOSTILE } },
  { kind: "dlmmClose", vault: VAULT, position: "P", pairLabel: HOSTILE },
  { kind: "jupiterInit", vault: VAULT, token: { ...hostileToken, mint: HOSTILE }, verified: false },
  { kind: "phoenixInit", vault: VAULT },
  { kind: "phoenixOnboard", vault: VAULT },
  { kind: "phoenixDeposit", vault: VAULT, amountBaseUnits: "1" },
  { kind: "phoenixWithdraw", vault: VAULT, amountBaseUnits: "1" },
  { kind: "phoenixOrder", vault: VAULT, order: { symbol: HOSTILE, side: "short", size: HOSTILE, reduceOnly: true, order: { type: "limit", price: HOSTILE, postOnly: true } } },
  { kind: "phoenixOrder", vault: VAULT, order: { symbol: HOSTILE, side: "long", size: HOSTILE, reduceOnly: false, order: { type: "market", slippageBps: 50 } } },
  { kind: "phoenixCancel", vault: VAULT, symbol: HOSTILE },
  { kind: "phoenixSweep", vault: VAULT },
  { kind: "vaultCreate", name: HOSTILE, deposit: { ...hostileToken, mint: HOSTILE }, ...hostileParams },
  { kind: "vaultUpdate", vault: VAULT, deposit: hostileToken, changes: { status: "paused", depositPaused: true, withdrawalPaused: false, ...hostileParams } },
  { kind: "vaultClaimFee", vault: VAULT },
  { kind: "vaultClose", vault: VAULT },
];

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
        "<b>Value</b>",
        "├ Live <b>2.5 USDC</b>",
        "├ In USD $2.50",
        "├ Last NAV 2.4 USDC",
        "└ Live vs NAV 🟢 +4.17%",
        "<blockquote>⚠️ Partial view: no price for MYSTERY. Missing value is not zero.</blockquote>",
        "",
        "<b>Tokens</b> (2)",
        "",
        "<b>USDC</b> <code>████░░░░░░</code> 40.00%",
        "├ Amount 1",
        "└ Value $1.00",
        "",
        "<b>SOL</b> <code>██████░░░░</code> 60.00%",
        "├ Amount 0.01",
        "└ Value $1.50",
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
      settingsMessage(hostileDetail),
      phoenixMessage(hostileVault, hostilePhoenix),
      phoenixMessage(hostileVault, phoenixNone),
      phoenixMessage(hostileVault, phoenixRegistered),
      phoenixMessage(hostileVault, { ...phoenixNone, usdcVault: false }),
      phoenixMessage(hostileVault, { ...phoenixReady, openOrders: null, account: null }),
      navHistoryMessage(hostileVault, navHistory),
      requestsMessage(hostileVault, { deposits: [{ owner: HOSTILE, epoch: "1", createdTs: 0, state: "pending", cancellable: true, amount: "1" }], withdrawals: [] }),
      strategyHistoryMessage(hostileVault, [{ ...hostileClosed, tokens: [hostileFlow, { ...hostileFlow, decimals: null }] }]),
      orderFormMessage(hostileOrder),
      orderFormMessage({ ...hostileOrder, type: "market", symbol: undefined, size: undefined }),
      phoenixTransferFormMessage({ kind: "phoenixTransfer", direction: "withdraw", vault: VAULT, usdc: hostileToken, amount: { kind: "exact", baseUnits: "1" } }),
      vaultFormMessage(hostileVaultForm),
      vaultFormMessage({ ...hostileVaultForm, vault: VAULT, current: { ...hostileParams, minDeposit: "2" } }),
      trackFormMessage({ kind: "track", vault: VAULT, deposit: hostileToken, token: hostilePicked }),
      ...hostileActions.map((action) => confirmMessage(hostileVault, action)),
      ...hostileActions.map((action) => executionMessage(action, [], { kind: "confirmed", signatures: [], created: { vault: HOSTILE, position: HOSTILE } })),
      ...hostileActions.map((action) => executionMessage(action, [], { kind: "failed", signatures: [], code: "Forbidden", message: "Action is not enabled for this key" }, HOSTILE)),
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

  it("shows vault settings in percent and token units", () => {
    expect(settingsMessage({ ...vaultDetail, pendingPerformanceFeeBps: 1500, feeEffectiveTs: 1_790_100_000 })).toBe(
      [
        "⚙️ <b>Demo</b> · settings",
        "",
        "<b>Status</b>",
        "├ Vault 🟢 normal",
        "├ Deposits ▶️ open",
        "└ Withdrawals ⏸ paused",
        "",
        "<b>Fees</b>",
        "├ Performance 10%",
        "└ Management 2% a year",
        "<i>Changing to 15% and 2% on 2026-09-22 18:00 UTC.</i>",
        "",
        "<b>Limits</b>",
        "├ Deposit cap 1,000 USDC",
        "├ Min deposit 10 USDC",
        "└ Min withdrawal 1 shares",
        "",
        "<b>Pending</b>",
        "├ Deposits 5 USDC",
        "├ Withdrawals 2 shares",
        "├ Unclaimed manager fee 0.5 shares",
        "└ Open strategies 3",
      ].join("\n"),
    );
  });

  it("shows Phoenix margin, positions, and open orders once ready", () => {
    expect(phoenixMessage(vaultSummary, phoenixReady)).toBe(
      [
        "📈 <b>Demo</b> · Phoenix perps",
        "",
        "Trader",
        "<code>Trader1111111111111111111111111111111111111</code>",
        "",
        "<b>Account</b>",
        "├ Equity <b>5.25 USDC</b>",
        "├ Collateral 5 USDC",
        "├ Withdrawable 4 USDC",
        "└ Risk 🟢 healthy",
        "",
        "<b>Margin</b> <code>██░░░░░░░░</code> 19.04% of equity",
        "├ Used 1 USDC",
        "└ Maintenance 0.5 USDC",
        "",
        "<b>Positions</b> (1)",
        "• SOL · liquidation at $98.5",
        "",
        "<b>Open orders</b> (2)",
        "🟢 <b>SOL long</b> 0.5 at $140",
        "🔴 <b>SOL short</b> 0.25 at $170 · reduce-only",
      ].join("\n"),
    );
    expect(phoenixMessage(vaultSummary, phoenixNone)).toBe(
      "📈 <b>Demo</b> · Phoenix perps\n\nNo Phoenix strategy yet.\n<i>Step 1 of 2: set up the strategy. Step 2 registers the vault's trader with Phoenix.</i>",
    );
  });

  it("lists NAVs newest first with per-epoch change, a trend line, and admin overrides", () => {
    expect(navHistoryMessage(vaultSummary, navHistory)).toBe(
      [
        "📊 <b>Demo</b> · NAV history",
        "<i>Latest 2 epochs, newest first</i>",
        "",
        "<b>NAV per share</b>, oldest → newest",
        "<code>▁█</code>",
        "├ Now <b>1.02</b>",
        "└ Over 2 epochs 🟢 +2.0000%",
        "",
        "<b>Epoch 124</b> · 2026-09-21 20:00 UTC",
        "├ Assets <b>1.5 USDC</b>",
        "├ Per share 1.02 · 🟢 +2.0000%",
        "└ ⚠️ Admin override",
        "",
        "<b>Epoch 123</b> · 2026-09-21 16:00 UTC",
        "├ Assets <b>1.4 USDC</b>",
        "└ Per share 1",
      ].join("\n"),
    );
    const [oldest] = navHistory;
    if (!oldest) throw new Error("fixture missing");
    const dip = { ...oldest, epoch: 125, ts: null, navPerShare: "1019999999", overridden: false };
    expect(navHistoryMessage(vaultSummary, [dip]).split("\n").slice(-3)).toEqual(["<b>Epoch 125</b>", "├ Assets <b>1.4 USDC</b>", "└ Per share 1.019999999"]);
    expect(navHistoryMessage(vaultSummary, [...navHistory, dip]).split("\n")).toContain("└ Per share 1.019999999 · 🔴 -0.0000%");
    expect(navHistoryMessage(vaultSummary, [])).toBe("📊 <b>Demo</b> · NAV history\n\nNo NAV posted yet.");
  });

  it("lists queued requests with their state in words", () => {
    expect(requestsMessage(vaultSummary, requestQueue)).toBe(
      [
        "📋 <b>Demo</b> · queued requests",
        "",
        "<b>Deposits</b> (1)",
        "• 5 USDC from Owne…1111 · waiting for the next NAV",
        "",
        "<b>Withdrawals</b> (1)",
        "• 2 shares from Owne…2222 · ready to settle",
        "",
        "<i>Requests settle after a later NAV is posted. Anyone can settle a ready request.</i>",
      ].join("\n"),
    );
  });

  it("shows realized PnL of closed strategies with signs, hold time, fees, and combined totals", () => {
    expect(strategyHistoryMessage(vaultSummary, strategyHistory)).toBe(
      [
        "🗂 <b>Demo</b> · closed strategies",
        "<i>Latest 1, newest first</i>",
        "",
        "<b>Realized PnL</b>, all 1 combined",
        "├ 🔴 USDC <b>-0.5</b>",
        "└ 🟢 SOL <b>+0.01</b>",
        "",
        "<b>Meteora DLMM</b> · USDC/SOL",
        "🕓 Closed 2026-09-21 20:00 UTC",
        `⏱ Held 5h 46m · 🔗 <a href="https://solscan.io/tx/${strategyHistory[0]?.closeSignature}">5igCLo…1111</a>`,
        "├ 🔴 USDC <b>-0.5</b>",
        "└ 🟢 SOL <b>+0.01</b>",
        "<i>Opened before exact accounting; totals may be incomplete.</i>",
      ].join("\n"),
    );
    const [closed] = strategyHistory;
    if (!closed) throw new Error("fixture missing");
    const earning = { ...closed, exact: true, tokens: closed.tokens.map((token) => ({ ...token, feesRetained: "200000", realizedPnl: "200000" })) };
    const lines = strategyHistoryMessage(vaultSummary, [earning, earning]).split("\n");
    expect(lines.slice(3, 6)).toEqual(["<b>Realized PnL</b>, all 2 combined", "├ 🟢 USDC <b>+0.4</b>", "└ 🟢 SOL <b>+0.0004</b>"]);
    expect(lines).toContain("├ 🟢 USDC <b>+0.2</b> · fees +0.2");
  });

  it("explains new API error codes in plain words", () => {
    expect(errorHint("Forbidden", "Action is not enabled for this key", "phoenix/order")).toBe(
      'This API key may not do "phoenix/order". Ask an admin to enable "phoenix/order" and "send" for this key in the dashboard.',
    );
    expect(errorHint("Forbidden", "Vault creation requires a key without a vault restriction", "vault/initialize")).toBe(
      'Creating a vault needs an API key that is not limited to specific vaults. Ask an admin for one with "vault/initialize" and "send".',
    );
    expect(errorHint("Forbidden", "Manager is not the current vault authority", "read")).toBeUndefined();
    expect(errorHint("PhoenixAlreadyOnboarded")).toBe("The vault's Phoenix trader is already onboarded. Open 📈 Phoenix again to deposit and trade.");
    expect(errorHint("VaultHasOpenStrategies")).toBe("Strategies are still open. Close every strategy first.");
  });
});
