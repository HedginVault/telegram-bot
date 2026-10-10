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
  confirmMessage,
  rangeGauge,
  lpFormMessage,
  strategiesMessage,
  swapFormMessage,
  swapQuoteMessage,
  vaultMessage,
  vaultsMessage,
  positionMessage,
  removeAmountMessage,
  removePickMessage,
  removeRangeAmountMessage,
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
const hostileLp: LpForm = {
  kind: "lp",
  mode: "open",
  vault: VAULT,
  deposit: hostileToken,
  pool: hostilePool,
  baseFeePct: 0.25,
  side: "x",
  rangeBps: 500,
  shape: "bidAsk",
  minPrice: 1,
  maxPrice: 2,
  amountX: { kind: "exact", baseUnits: "1" },
  amountY: { kind: "share", bps: 5000 },
};
const hostileChoice = { address: "P", pair: HOSTILE, binStep: 10, baseFeePct: 0.2, tvl: 5, volume24h: null };
const hostileDlmm: Strategy = {
  type: "dlmm",
  address: "S2",
  position: HOSTILE,
  tokenX: hostileToken,
  tokenY: hostileToken,
  lowerPrice: HOSTILE,
  upperPrice: HOSTILE,
  activePrice: HOSTILE,
  amountX: "1",
  amountY: "2",
  pendingFeeX: "3",
  pendingFeeY: "4",
};
const hostileBins = { side: "above" as const, lowerBinId: 1, upperBinId: 4, priceRange: { low: HOSTILE, high: HOSTILE } };
const hostileSide = { bins: hostileBins, token: hostileToken, activeBinId: 0, amountBaseUnits: "5", amountIsSideTotal: false };
const hostileRange = {
  label: HOSTILE,
  lowerBinId: 1,
  upperBinId: 4,
  priceRange: { low: HOSTILE, high: HOSTILE },
  tokenX: hostileToken,
  tokenY: hostileToken,
  amountXBaseUnits: "5",
  amountYBaseUnits: "6",
};
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
  { kind: "dlmmAdd", vault: VAULT, position: "P", pairLabel: HOSTILE, liquidity: hostileLiquidity },
  { kind: "dlmmRemove", vault: VAULT, position: "P", pairLabel: HOSTILE, bps: 10_000 },
  { kind: "dlmmRemove", vault: VAULT, position: "P", pairLabel: HOSTILE, bps: 5000, bins: hostileBins },
  { kind: "dlmmRemove", vault: VAULT, position: "P", pairLabel: HOSTILE, bps: 2500, bins: hostileRange },
  { kind: "dlmmFlip", vault: VAULT, position: "P", pairLabel: HOSTILE, ...hostileSide },
  { kind: "dlmmFlip", vault: VAULT, position: "P", pairLabel: HOSTILE, ...hostileSide, amountIsSideTotal: true },
  { kind: "dlmmZapOut", vault: VAULT, position: "P", pairLabel: HOSTILE, depositSymbol: HOSTILE },
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
  it("lists vaults on two lines each with a compact amount and a short Solscan link", () => {
    expect(vaultsMessage([vaultSummary, { ...vaultSummary, name: "Dust", status: "paused", totalAssets: "51673" }])).toBe(
      [
        "🏦 <b>Your vaults</b> (2)",
        "",
        "<b>1. Demo</b> · 🟢 normal",
        `└ <b>1.5 USDC</b> · <a href="https://solscan.io/account/${VAULT}">Vau1…1111 ↗</a>`,
        "",
        "<b>2. Dust</b> · 🔴 paused",
        `└ <b>0.05167 USDC</b> · <a href="https://solscan.io/account/${VAULT}">Vau1…1111 ↗</a>`,
      ].join("\n"),
    );
    expect(vaultsMessage([])).toBe("🏦 This API key has no vaults in scope.");
  });

  it("shows the vault overview with aligned tokens, positions, and the partial-view warning", () => {
    expect(vaultMessage(vaultSummary, holdings, strategies)).toBe(
      [
        "🏦 <b>Demo</b> · 🟢 normal",
        `<code>${VAULT}</code>`,
        "",
        "💰 <b>2.5 USDC</b> ≈ $2.50 · vs NAV 🟢 +4.17%",
        "<blockquote>⚠️ Partial view: no price for MYSTERY. Missing value is not zero.</blockquote>",
        "",
        "<b>Tokens</b>",
        "<code>SOL  ██████░░░░ 60.0%</code> 0.01 · $1.50",
        "<code>USDC ████░░░░░░ 40.0%</code> 1 · $1.00",
        "",
        "<b>Positions</b>",
        "🌊 <b>SOL/USDC</b> LP · 🟢 in range",
        "<code>140 ├─────●────┤ 160</code> now 150",
        "└ 0.5 SOL + 75 USDC",
        "📈 <b>Perps</b> · 12.3456 USDC equity · leverage n/a",
        "⚠️ Unreadable dlmm strategy",
      ].join("\n"),
    );
  });

  it("omits positions and the warning when there are none, and marks out-of-range LPs", () => {
    const complete = { ...holdings, partial: false, unpriced: [], navDeltaBps: null, totalUsd: null };
    const lines = vaultMessage(vaultSummary, complete, []).split("\n");
    expect(lines[3]).toBe("💰 <b>2.5 USDC</b>");
    expect(lines.some((line) => line.includes("Partial view") || line.includes("Positions"))).toBe(false);
    const [, dlmm] = strategies;
    if (dlmm?.type !== "dlmm") throw new Error("fixture missing");
    const priced = { ...dlmm, tokenX: { ...dlmm.tokenX, priceUsd: 150 }, tokenY: { ...dlmm.tokenY, priceUsd: 1 }, pnlUsd: -1.5, pnlPct: -2.25 };
    expect(vaultMessage(vaultSummary, complete, [{ ...priced, activePrice: "170" }, { type: "phoenix", address: "S", equity: "1995800", leverage: 0 }])).toContain(
      [
        "<b>Positions</b>",
        "🌊 <b>SOL/USDC</b> LP · 🟠 out of range",
        "<code>140 ├─────────▶┤ 160</code> now 170",
        "└ $150.00 · PnL 🔴 -$1.50 (-2.25%) · fees $0.40",
        "📈 <b>Perps</b> · 1.9958 USDC equity · 0.00x",
      ].join("\n"),
    );
  });

  it("shows one LP position as a card with value, PnL, fees, range, and age", () => {
    const [, dlmm] = strategies;
    if (dlmm?.type !== "dlmm") throw new Error("fixture missing");
    const priced = { ...dlmm, tokenX: { ...dlmm.tokenX, priceUsd: 150 }, tokenY: { ...dlmm.tokenY, priceUsd: 1 }, pnlUsd: -1.5, pnlPct: -2.25, createdTs: 1_790_000_000 };
    expect(positionMessage(vaultSummary, priced, 1_790_000_000 + 106_200)).toBe(
      [
        "🌊 <b>SOL/USDC</b> · Meteora DLMM",
        `Demo · <a href="https://solscan.io/account/${dlmm.position}">Position Pos1…1111 ↗</a>`,
        "━━━━━━━━━━━━",
        "🟢 <b>In range</b> · 50% through",
        "<code>140 ├─────●────┤ 160</code>",
        "",
        "💰 <b>Value $150.00</b>",
        "├ 0.5 SOL ($75.00)",
        "└ 75 USDC ($75.00)",
        "",
        "📈 <b>PnL 🔴 -$1.50 (-2.25%)</b>",
        "└ <i>All-time, from Meteora</i>",
        "",
        "🎁 <b>Unclaimed fees $0.40</b>",
        "├ 0.001 SOL",
        "└ 0.25 USDC",
        "",
        "🎯 <b>Range</b> · USDC per SOL",
        "├ Min 140",
        "├ Now <b>150</b>",
        "└ Max 160",
        "",
        "📅 Opened 2026-09-21 14:13 UTC · open 1d 5h",
        `<code>${dlmm.position}</code>`,
      ].join("\n"),
    );
    const below = positionMessage(vaultSummary, { ...dlmm, activePrice: "130" }, 0);
    expect(below).toContain("🟠 <b>Out of range</b> · price below your range\n<code>140 ├◀─────────┤ 160</code>");
    expect(below).toContain("💰 <b>Value n/a</b>\n├ 0.5 SOL\n└ 75 USDC");
    expect(below).not.toContain("PnL");
    expect(below).not.toContain("Opened");
    expect(below).not.toContain("Flip");
  });

  it("explains a missing flip in one italic line", () => {
    const [, dlmm] = strategies;
    if (dlmm?.type !== "dlmm") throw new Error("fixture");
    const line = (blocked: Parameters<typeof positionMessage>[3]) => positionMessage(vaultSummary, dlmm, 0, blocked).split("\n").filter((l) => l.includes("Flip"));
    const sol = { mint: dlmm.tokenX.mint, symbol: "SOL", decimals: 9 };
    expect(line({ reason: "noBins" })).toEqual(["<i>🔁 Flip unavailable: this server doesn't report bins</i>"]);
    expect(line({ reason: "empty", token: sol, side: "above", inActiveBin: false })).toEqual(["<i>🔁 Flip SOL: no SOL above the price to flip</i>"]);
    expect(line({ reason: "empty", token: { ...sol, symbol: "USDC" }, side: "below", inActiveBin: true })).toEqual([
      "<i>🔁 Flip USDC: no USDC below the price to flip (the USDC in the current-price bin isn't flipped)</i>",
    ]);
  });

  it("draws the price on a range gauge, with an arrow at the edge when out of range", () => {
    expect(rangeGauge(140, 150, 160)).toBe("├─────●────┤");
    expect(rangeGauge(140, 140, 160)).toBe("├●─────────┤");
    expect(rangeGauge(140, 160, 160)).toBe("├─────────●┤");
    expect(rangeGauge(140, 120, 160)).toBe("├◀─────────┤");
    expect(rangeGauge(140, 200, 160)).toBe("├─────────▶┤");
    expect(rangeGauge(Number.NaN, 1, 2)).toBe("├──────────┤");
  });

  it("groups strategies by kind", () => {
    expect(strategiesMessage(vaultSummary, [...strategies, { type: "jupiter", address: "S5", symbol: "MET", decimals: 6, vaultBalance: "0" }])).toBe(
      [
        "🧩 <b>Demo</b> · strategies (5)",
        "",
        "💱 <b>Tokens</b>",
        "├ SOL 0.01",
        "└ MET 0 · <i>empty</i>",
        "",
        "🌊 <b>SOL/USDC</b> · Meteora DLMM · 🟢 in range",
        "<code>140 ├─────●────┤ 160</code>",
        "├ Now <b>150</b>",
        "├ Holds 0.5 SOL + 75 USDC",
        "└ Fees 0.001 SOL + 0.25 USDC",
        "<code>Pos1111111111111111111111111111111111111111</code>",
        "",
        "📈 <b>Phoenix perps</b>",
        "└ Equity 12.3456 USDC · leverage n/a",
        "",
        "⚠️ <b>Unreadable dlmm strategy</b>",
        "<code>Strat4444444444444444444444444444444444444</code>",
        "<i>position account missing</i>",
      ].join("\n"),
    );
    expect(strategiesMessage(vaultSummary, [])).toBe("🧩 <b>Demo</b> · strategies\n\nNo open strategies.");
  });

  it("renders a swap confirm as a receipt with a fresh quote", () => {
    const usdc = { mint: "U", symbol: "USDC", decimals: 6 };
    const sol = { mint: "S", symbol: "SOL", decimals: 9 };
    expect(confirmMessage(vaultSummary, { kind: "swap", vault: VAULT, input: usdc, output: sol, amountBaseUnits: "1000000", slippageBps: 50, unverified: false }, quote)).toBe(
      [
        "🧾 <b>Review</b> · Demo",
        "━━━━━━━━━━━━",
        "<b>Swap 1 USDC → SOL</b>",
        "├ You get <b>≈ 0.006666666 SOL</b>",
        "└ Slippage 0.5% · impact 0.01%",
        "━━━━━━━━━━━━",
        "<blockquote>⚡ Real mainnet transaction from the vault. Cannot be undone.</blockquote>",
      ].join("\n"),
    );
  });

  it("renders a new LP position confirm with range, bins, and transactions", () => {
    const liquidity = { tokenX: { mint: "M", symbol: "MET", decimals: 6 }, tokenY: { mint: "U", symbol: "USDC", decimals: 6 }, amountX: "0", amountY: "5000000", shape: "spot" as const };
    const action: PendingAction = { kind: "dlmmOpen", vault: VAULT, lbPair: "P", pairLabel: "MET/USDC", lowerBinId: -26, upperBinId: 26, priceRange: { low: "0.4247", high: "0.4694" }, liquidity };
    expect(confirmMessage(vaultSummary, action)).toBe(
      [
        "🧾 <b>Review</b> · Demo",
        "━━━━━━━━━━━━",
        "<b>Open MET/USDC LP</b>",
        "├ Deposit 5 USDC",
        "├ Range 0.4247 → 0.4694",
        "├ Bins 52 · Spot",
        "└ Transactions ~1",
        "━━━━━━━━━━━━",
        "<i>Creating the position costs a small refundable SOL rent from the manager wallet.</i>",
        "<blockquote>⚡ Real mainnet transaction from the vault. Cannot be undone.</blockquote>",
      ].join("\n"),
    );
    expect(confirmMessage(undefined, { kind: "vaultClaimFee", vault: VAULT })).toContain("from your manager wallet. Cannot be undone.");
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
      vaultMessage(
        hostileVault,
        { ...holdings, unpriced: [HOSTILE], tokens: [...holdings.tokens, { token: hostileToken, amount: "1", usd: null, shareBps: null }] },
        [...strategies, ...hostileStrategies, hostileDlmm],
      ),
      strategiesMessage(hostileVault, [...strategies, ...hostileStrategies, hostileDlmm]),
      hostileDlmm.type === "dlmm" ? positionMessage(hostileVault, { ...hostileDlmm, pnlUsd: -1, pnlPct: -1, createdTs: 1 }, 2) : "",
      hostileDlmm.type === "dlmm" ? positionMessage(hostileVault, hostileDlmm, 2, { reason: "noBins" }) : "",
      hostileDlmm.type === "dlmm" ? positionMessage(hostileVault, hostileDlmm, 2, { reason: "empty", token: hostileToken, side: "above", inActiveBin: true }) : "",
      hostileDlmm.type === "dlmm" ? positionMessage(hostileVault, hostileDlmm, 2, { reason: "empty", token: hostileToken, side: "below", inActiveBin: false }) : "",
      hostileDlmm.type === "dlmm" ? removePickMessage(hostileDlmm, hostileSide, null) : "",
      hostileDlmm.type === "dlmm" ? removePickMessage({ ...hostileDlmm, lowerBinId: 0, upperBinId: 5, activeBinId: 2 }, null, { ...hostileSide, amountIsSideTotal: true }) : "",
      hostileDlmm.type === "dlmm" ? removeAmountMessage(hostileDlmm, hostileSide) : "",
      hostileDlmm.type === "dlmm" ? removeAmountMessage(hostileDlmm, null) : "",
      hostileDlmm.type === "dlmm" ? removePickMessage(hostileDlmm, null, null, [{ button: HOSTILE, bins: hostileRange }]) : "",
      hostileDlmm.type === "dlmm" ? removeRangeAmountMessage(hostileDlmm, hostileRange) : "",
      errorMessage(HOSTILE, HOSTILE),
      swapFormMessage(hostileSwap, "5"),
      swapFormMessage({ ...hostileSwap, token: undefined, amount: undefined }, undefined),
      swapQuoteMessage(hostileSwap, { input: hostileToken, output: hostileToken }, "1", { ...quote, priceImpactPct: HOSTILE, routeLabels: [HOSTILE] }),
      lpFormMessage(hostileLp, "range error " + HOSTILE, { x: "1", y: "2" }),
      lpFormMessage({ ...hostileLp, pool: undefined, poolQuery: HOSTILE, poolChoices: [hostileChoice] }, undefined, undefined),
      lpFormMessage({ ...hostileLp, pool: undefined }, undefined, undefined),
      lpFormMessage(hostileLp, { lowerBinId: 0, upperBinId: 5, binCount: 5, sides: "x", lowPrice: 1, highPrice: 2 }, undefined),
      lpFormMessage({ ...hostileLp, side: "y", rangeBps: undefined }, { lowerBinId: 0, upperBinId: 5, binCount: 5, sides: "y", lowPrice: 1, highPrice: 2 }, { x: "1", y: "2" }),
      lpFormMessage({ ...hostileLp, mode: "add", baseFeePct: null }, undefined, { x: "1", y: "2" }),
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

  it("renders a flip confirm with token, amount, range, bins, and the atomic note", () => {
    const action: PendingAction = {
      kind: "dlmmFlip",
      vault: VAULT,
      position: "P",
      pairLabel: "SOL/USDC",
      token: { mint: "So1", symbol: "SOL", decimals: 9 },
      bins: { side: "above", lowerBinId: -99, upperBinId: -90, priceRange: { low: "150.15", high: "151.5068" } },
      activeBinId: -100,
      amountBaseUnits: "400000000",
      amountIsSideTotal: false,
    };
    expect(confirmMessage(vaultSummary, action)).toBe(
      [
        "🧾 <b>Review</b> · Demo",
        "━━━━━━━━━━━━",
        "<b>Flip SOL to Bid-Ask in SOL/USDC LP</b>",
        "├ Token <b>SOL</b>",
        "├ Amount ≈ 0.4 SOL",
        "├ Range 150.15 → 151.5068",
        "└ Bins 10 · above the price",
        "━━━━━━━━━━━━",
        "<i>One atomic transaction: withdraws all SOL from these bins and re-adds it to the same bins as Bid-Ask.</i>",
        "<i>If the price moves more than 10 bins first, it fails and nothing changes.</i>",
        "<i>Does not claim fees. Use 💰 Claim fees for those.</i>",
        "<blockquote>⚡ Real mainnet transaction from the vault. Cannot be undone.</blockquote>",
      ].join("\n"),
    );
  });

  it("lists each transaction once at its latest state", () => {
    const action: PendingAction = { kind: "dlmmZapOut", vault: VAULT, position: "P", pairLabel: "SOL/USDC", depositSymbol: "USDC" };
    const html = executionMessage(action, [
      { kind: "building", action: "dlmm/zap-out" },
      { kind: "sent", signature: "sigA", status: "pending" },
      { kind: "sent", signature: "sigB", status: "pending" },
      { kind: "sent", signature: "sigC", status: "unknown" },
      { kind: "confirmed", signature: "sigA" },
    ]);
    const tx = (signature: string, n: number) => `<a href="https://solscan.io/tx/${signature}">#${n}</a>`;
    expect(html.split("\n").slice(2, 6)).toEqual([
      "🛠 <code>dlmm/zap-out</code>",
      `✅ Confirmed ${tx("sigA", 1)}`,
      `📤 Sent ${tx("sigB", 2)}`,
      `❓ Checking ${tx("sigC", 3)}`,
    ]);
    expect(() => assertTelegramHtml(html)).not.toThrow();
  });

  it("collapses a successful action to a single done line", () => {
    const action: PendingAction = { kind: "dlmmZapOut", vault: VAULT, position: "P", pairLabel: "SOL/USDC", depositSymbol: "USDC" };
    const progress = [
      { kind: "building", action: "dlmm/zap-out" },
      { kind: "sent", signature: "sigA", status: "pending" },
      { kind: "confirmed", signature: "sigA" },
    ] as const;
    const html = executionMessage(action, [...progress], { kind: "confirmed", signatures: ["sigA", "sigB"] });
    expect(html).toBe("✅ <b>Zap out the SOL/USDC position to USDC</b>\n\n<b>Done.</b> 2 confirmed.");
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
    expect(errorHint("Stale")).toBe("The pool price moved since the bot read it, so this step was not sent. Refresh and try again.");
  });
});
