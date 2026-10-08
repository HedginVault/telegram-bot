import {
  DLMM_BINS_PER_TRANSACTION,
  type Holdings,
  type NavHistoryPoint,
  type Outcome,
  type PhoenixManager,
  type PriceRange,
  type Progress,
  type Quote,
  type RequestQueue,
  type Strategy,
  type StrategyHistoryItem,
  type VaultDetail,
  type VaultStatus,
  type VaultSummary,
} from "@hedginvault/sdk";
import type { Liquidity, PendingAction, VaultChanges } from "./actions";
import {
  type LpForm,
  NO_DEPOSIT_CAP,
  type OrderForm,
  type PhoenixTransferForm,
  type SwapForm,
  type TrackForm,
  type VaultForm,
  type VaultParams,
  describeAmount,
  formatPrice,
  needsWarning,
  shapeLabel,
  vaultChanges,
} from "./forms";
import type { TokenRef } from "./ui";
import { formatBaseUnits, shortAddress } from "./format";

// Telegram counts the limit after parsing entities, so measuring raw HTML is conservative.
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATED = "\n<i>… truncated</i>";

/** Every API-provided value goes through this before it is placed in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Telegram rejects longer messages outright. Cut at a line break: every tag opens and closes
 * on one line, so the result stays valid HTML.
 */
export function fitMessage(html: string): string {
  if (html.length <= TELEGRAM_MESSAGE_LIMIT) return html;
  const room = html.slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATED.length);
  return room.slice(0, room.lastIndexOf("\n")) + TRUNCATED;
}

const amount = (baseUnits: string, decimals: number, symbol: string) =>
  `${formatBaseUnits(baseUnits, decimals)} ${escapeHtml(symbol)}`;
const usd = (value: number | null) =>
  value === null ? "no price" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (bps: number | null) => (bps === null ? "?" : `${(bps / 100).toFixed(2)}%`);
const signedPercent = (bps: number | null) => (bps !== null && bps > 0 ? `+${percent(bps)}` : percent(bps));
const address = (value: string) => `<code>${escapeHtml(value)}</code>`;
const shortSig = (signature: string) => `${signature.slice(0, 6)}…${signature.slice(-4)}`;
const txLink = (signature: string) => `<a href="https://solscan.io/tx/${encodeURIComponent(signature)}">${escapeHtml(shortSig(signature))}</a>`;
const solscan = (value: string) => `<a href="https://solscan.io/account/${encodeURIComponent(value)}">Solscan</a>`;
/** Signed base units (a loss, negative equity) without going through `number`. */
const signedAmount = (baseUnits: string, decimals: number, symbol: string) =>
  baseUnits.startsWith("-") ? `-${amount(baseUnits.slice(1), decimals, symbol)}` : amount(baseUnits, decimals, symbol);
// Phoenix collateral, equity, and margin are USDC base units.
const usdcAmount = (baseUnits: string) => signedAmount(baseUnits, 6, "USDC");
const feePercent = (bps: number) => `${bps / 100}%`;
/** Shares have the deposit token's decimals. */
const shares = (baseUnits: string, decimals: number) => `${formatBaseUnits(baseUnits, decimals)} shares`;
const cap = (baseUnits: string, token: TokenRef) => (baseUnits === NO_DEPOSIT_CAP ? "no cap" : amount(baseUnits, token.decimals, token.symbol));
/** Unix seconds → "2026-10-08 12:00 UTC", the same on every machine. */
const utc = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const STATUS_LABEL: Record<string, string> = {
  normal: "🟢 normal",
  reduceOnly: "🟡 reduce only",
  paused: "🔴 paused",
};
const status = (value: string) => STATUS_LABEL[value] ?? `⚪ ${escapeHtml(value)}`;

export const HELP_MESSAGE = [
  "🤖 <b>Hedge Vault manager bot</b>",
  "",
  "Add your manager wallet under 👛 <b>Wallet</b> (import its private key, or create a new one), add the API key an admin issued for it, then tap <b>Vaults</b>.",
  "",
  "<b>Swap</b> · Vault → 💱 Swap. Pick a held token or paste any token's contract address, then set the amount (\"1.5\", \"25%\", \"max\") and slippage.",
  "<b>LP</b> · Vault → ➕ New LP position. Paste a pool or search by symbol, pick a shape, set min and max price, and size each token.",
  "",
  "<b>Commands</b>",
  "/vaults · vaults your active wallet manages",
  "/wallet · import, create, export, or switch wallets",
  "/holdings &lt;vault&gt; · what a vault holds and is worth",
  "/strategies &lt;vault&gt; · open strategies",
  "/nav &lt;vault&gt; · last posted NAVs",
  "/requests &lt;vault&gt; · queued deposits and withdrawals",
  "/history &lt;vault&gt; · closed strategies",
  "/phoenix &lt;vault&gt; · Phoenix perps: setup, margin, orders",
  "/settings &lt;vault&gt; · fees, limits, status, pauses",
  "/cancel · stop typing into a form",
  "",
  "• &lt;vault&gt; is a number from /vaults, an address, or a vault name.",
  "• Tap an address to copy it.",
  "• Form and confirm buttons stop working when the bot restarts. Send /start for fresh ones.",
].join("\n");

export function vaultsMessage(vaults: VaultSummary[]): string {
  if (vaults.length === 0) return "🏦 This API key has no vaults in scope.";
  const blocks = vaults.map((vault, index) =>
    [
      `<b>${index + 1}. ${escapeHtml(vault.name)}</b> · ${status(vault.status)}`,
      address(vault.address),
      `TVL <b>${amount(vault.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b> · ${solscan(vault.address)}`,
    ].join("\n"),
  );
  return [`🏦 <b>Your vaults</b> (${vaults.length})`, ...blocks].join("\n\n");
}

export function vaultMessage(vault: VaultSummary): string {
  return [
    `🏦 <b>${escapeHtml(vault.name)}</b> · ${status(vault.status)}`,
    address(vault.address),
    "",
    `TVL <b>${amount(vault.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b> · ${solscan(vault.address)}`,
    "",
    "<i>What do you want to see?</i>",
  ].join("\n");
}

export function holdingsMessage(vault: VaultSummary, holdings: Holdings): string {
  const deposit = holdings.depositToken;
  const lines = [
    `📊 <b>${escapeHtml(vault.name)}</b> · holdings`,
    "",
    `Live value <b>${amount(holdings.totalValue, deposit.decimals, deposit.symbol)}</b> (${usd(holdings.totalUsd)})`,
    `Last NAV ${amount(holdings.navTotalAssets, deposit.decimals, deposit.symbol)} · <i>live vs NAV ${signedPercent(holdings.navDeltaBps)}</i>`,
  ];
  if (holdings.partial) {
    const unpriced = holdings.unpriced.map(escapeHtml).join(", ") || "some tokens";
    lines.push(`<blockquote>⚠️ Partial view: no price for ${unpriced}. Missing value is not zero.</blockquote>`);
  }
  lines.push("", "<b>Tokens</b>");
  for (const exposure of holdings.tokens) {
    lines.push(
      `• <b>${escapeHtml(exposure.token.symbol)}</b> ${formatBaseUnits(exposure.amount, exposure.token.decimals)} · ${usd(exposure.usd)} · ${percent(exposure.shareBps)}`,
    );
  }
  return lines.join("\n");
}

function strategyBlock(strategy: Strategy): string[] {
  switch (strategy.type) {
    case "jupiter":
      return [`<b>Swap</b> · ${escapeHtml(strategy.symbol)}`, `Balance ${amount(strategy.vaultBalance, strategy.decimals, strategy.symbol)}`];
    case "dlmm":
      return [
        `<b>Meteora DLMM</b> · ${escapeHtml(strategy.tokenX.symbol)}/${escapeHtml(strategy.tokenY.symbol)}`,
        `Position ${address(strategy.position)}`,
        `Range ${escapeHtml(strategy.lowerPrice)} to ${escapeHtml(strategy.upperPrice)} · now <b>${escapeHtml(strategy.activePrice)}</b>`,
        `Holds ${amount(strategy.amountX, strategy.tokenX.decimals, strategy.tokenX.symbol)} + ${amount(strategy.amountY, strategy.tokenY.decimals, strategy.tokenY.symbol)}`,
      ];
    case "phoenix":
      return [
        "<b>Phoenix perps</b>",
        // Phoenix equity is in USDC atoms (6 decimals).
        `Equity ${amount(strategy.equity, 6, "USDC")} · leverage ${strategy.leverage === null ? "n/a" : `${strategy.leverage.toFixed(2)}x`}`,
      ];
    case "unreadable":
      return [
        `⚠️ <b>Unreadable ${escapeHtml(strategy.protocol)} strategy</b>`,
        address(strategy.address),
        `<i>${escapeHtml(strategy.reason)}</i>`,
      ];
  }
}

export function strategiesMessage(vault: VaultSummary, strategies: Strategy[]): string {
  const title = `🧩 <b>${escapeHtml(vault.name)}</b> · strategies`;
  if (strategies.length === 0) return `${title}\n\nNo open strategies.`;
  return [`${title} (${strategies.length})`, ...strategies.map((s) => strategyBlock(s).join("\n"))].join("\n\n");
}

type DlmmStrategy = Extract<Strategy, { type: "dlmm" }>;

export function positionMessage(vault: VaultSummary, strategy: DlmmStrategy): string {
  const { tokenX, tokenY } = strategy;
  const lines = [
    `⚙️ <b>${escapeHtml(tokenX.symbol)}/${escapeHtml(tokenY.symbol)} position</b> · ${escapeHtml(vault.name)}`,
    address(strategy.position),
    "",
    `Range ${escapeHtml(strategy.lowerPrice)} to ${escapeHtml(strategy.upperPrice)} · now <b>${escapeHtml(strategy.activePrice)}</b>`,
    `Holds ${amount(strategy.amountX, tokenX.decimals, tokenX.symbol)} + ${amount(strategy.amountY, tokenY.decimals, tokenY.symbol)}`,
    `Unclaimed fees ${amount(strategy.pendingFeeX, tokenX.decimals, tokenX.symbol)} + ${amount(strategy.pendingFeeY, tokenY.decimals, tokenY.symbol)}`,
  ];
  return lines.join("\n");
}

export function navHistoryMessage(vault: VaultSummary, points: NavHistoryPoint[]): string {
  const title = `📊 <b>${escapeHtml(vault.name)}</b> · NAV history`;
  if (points.length === 0) return `${title}\n\nNo NAV posted yet.`;
  const lines = [...points].reverse().map(
    (point) =>
      `• Epoch ${point.epoch}${point.ts === null ? "" : ` · ${utc(point.ts)}`}\n  <b>${amount(point.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b> · per share ${formatBaseUnits(point.navPerShare, 9)}${point.overridden ? " · ⚠️ admin override" : ""}`,
  );
  return [`${title} (latest ${points.length}, newest first)`, "", ...lines].join("\n");
}

const requestState = (state: "pending" | "resolvable") => (state === "resolvable" ? "ready to settle" : "waiting for the next NAV");

export function requestsMessage(vault: VaultSummary, queue: RequestQueue): string {
  const lines = [`📋 <b>${escapeHtml(vault.name)}</b> · queued requests`, "", `<b>Deposits</b> (${queue.deposits.length})`];
  if (queue.deposits.length === 0) lines.push("<i>None.</i>");
  for (const deposit of queue.deposits) {
    lines.push(`• ${amount(deposit.amount, vault.depositDecimals, vault.depositSymbol)} from ${escapeHtml(shortAddress(deposit.owner))} · ${requestState(deposit.state)}`);
  }
  lines.push("", `<b>Withdrawals</b> (${queue.withdrawals.length})`);
  if (queue.withdrawals.length === 0) lines.push("<i>None.</i>");
  for (const withdrawal of queue.withdrawals) {
    lines.push(`• ${shares(withdrawal.shares, vault.depositDecimals)} from ${escapeHtml(shortAddress(withdrawal.owner))} · ${requestState(withdrawal.state)}`);
  }
  lines.push("", "<i>Requests settle after a later NAV is posted. Anyone can settle a ready request.</i>");
  return lines.join("\n");
}

const STRATEGY_TYPE_LABEL = { jupiter: "Swap", dlmm: "Meteora DLMM", phoenix: "Phoenix perps" } as const;
export const STRATEGY_HISTORY_LIMIT = 10;

export function strategyHistoryMessage(vault: VaultSummary, items: StrategyHistoryItem[]): string {
  const title = `🗂 <b>${escapeHtml(vault.name)}</b> · closed strategies`;
  if (items.length === 0) return `${title}\n\nNo closed strategies yet.`;
  const blocks = items.slice(0, STRATEGY_HISTORY_LIMIT).map((item) => {
    const lines = [`<b>${item.type ? STRATEGY_TYPE_LABEL[item.type] : "Strategy"}</b> · closed ${utc(item.closedTs)} · ${txLink(item.closeSignature)}`];
    for (const token of item.tokens) {
      const pnl =
        token.decimals === null
          ? `${escapeHtml(token.realizedPnl)} base units of ${address(token.mint)}`
          : signedAmount(token.realizedPnl, token.decimals, token.symbol ?? shortAddress(token.mint));
      const loss = token.realizedPnl.startsWith("-");
      lines.push(`• Realized ${loss ? "loss" : "PnL"} <b>${loss || token.realizedPnl === "0" ? "" : "+"}${pnl}</b>`);
    }
    if (!item.exact) lines.push("<i>Opened before exact accounting; totals may be incomplete.</i>");
    return lines.join("\n");
  });
  return [`${title} (latest ${blocks.length}, newest first)`, ...blocks].join("\n\n");
}

const pauseLabel = (paused: boolean) => (paused ? "⏸ paused" : "▶️ open");

export function settingsMessage(vault: VaultDetail): string {
  const token = { mint: vault.depositMint, symbol: vault.depositSymbol, decimals: vault.depositDecimals };
  const lines = [
    `⚙️ <b>${escapeHtml(vault.name)}</b> · settings`,
    "",
    `Status ${status(vault.status)}${vault.protocol.status === "normal" ? "" : ` · protocol ${status(vault.protocol.status)}`}`,
    `Deposits ${pauseLabel(vault.depositPaused)} · withdrawals ${pauseLabel(vault.withdrawalPaused)}`,
    "",
    "<b>Fees</b>",
    `Performance ${feePercent(vault.performanceFeeBps)} · management ${feePercent(vault.managementFeeBps)} a year`,
  ];
  if (vault.pendingPerformanceFeeBps !== vault.performanceFeeBps || vault.pendingManagementFeeBps !== vault.managementFeeBps) {
    lines.push(`<i>Changing to ${feePercent(vault.pendingPerformanceFeeBps)} and ${feePercent(vault.pendingManagementFeeBps)} on ${utc(vault.feeEffectiveTs)}.</i>`);
  }
  lines.push(
    "",
    "<b>Limits</b>",
    `Deposit cap ${cap(vault.depositCap, token)}`,
    `Min deposit ${amount(vault.minDeposit, token.decimals, token.symbol)} · min withdrawal ${shares(vault.minWithdrawalShares, token.decimals)}`,
    "",
    "<b>Pending</b>",
    `Deposits ${amount(vault.pendingDeposits, token.decimals, token.symbol)} · withdrawals ${shares(vault.pendingWithdrawalShares, token.decimals)}`,
    `Unclaimed manager fee ${shares(vault.unclaimedManagerFeeShares, token.decimals)}`,
    `Open strategies ${vault.openStrategyCount}`,
  );
  return lines.join("\n");
}

export function phoenixMessage(vault: VaultSummary, phoenix: PhoenixManager): string {
  const lines = [`📈 <b>${escapeHtml(vault.name)}</b> · Phoenix perps`, ""];
  if (!phoenix.usdcVault) {
    lines.push(`Phoenix needs a vault whose deposit token is USDC. This vault uses ${escapeHtml(vault.depositSymbol)}.`);
    return lines.join("\n");
  }
  if (phoenix.status === "none") {
    lines.push("No Phoenix strategy yet.", "<i>Step 1 of 2: set up the strategy. Step 2 registers the vault's trader with Phoenix.</i>");
    return lines.join("\n");
  }
  lines.push(`Trader ${address(phoenix.traderAccount)}`);
  if (phoenix.status === "registered") {
    lines.push("", "<i>Step 2 of 2: onboard the trader with Phoenix. Then you can deposit USDC and trade.</i>");
    return lines.join("\n");
  }
  const { account } = phoenix;
  if (account) {
    lines.push(
      `Equity <b>${usdcAmount(account.equity)}</b> · collateral ${usdcAmount(account.collateral)}`,
      `Margin used ${usdcAmount(account.initialMargin)} · maintenance ${usdcAmount(account.maintenanceMargin)} · risk ${escapeHtml(account.riskState)}`,
      `Withdrawable ${usdcAmount(account.withdrawable)}`,
    );
    const positions = Object.entries(account.liquidationPrices);
    lines.push("", `<b>Positions</b> (${positions.length})`);
    if (positions.length === 0) lines.push("<i>None.</i>");
    for (const [symbol, price] of positions) lines.push(`• ${escapeHtml(symbol)} · liquidation at $${escapeHtml(price)}`);
  } else {
    lines.push("<i>Phoenix did not report margin right now.</i>");
  }
  if (phoenix.openOrders === null) {
    lines.push("", "<i>Phoenix did not report open orders right now.</i>");
  } else {
    lines.push("", `<b>Open orders</b> (${phoenix.openOrders.length})`);
    if (phoenix.openOrders.length === 0) lines.push("<i>None.</i>");
    for (const order of phoenix.openOrders) {
      lines.push(
        `• ${escapeHtml(order.symbol)} ${order.side} ${escapeHtml(order.size)} at $${escapeHtml(order.price)}${order.reduceOnly ? " · reduce-only" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function liquidityAmounts(liquidity: Liquidity): string {
  const parts = [
    liquidity.amountX !== "0" ? amount(liquidity.amountX, liquidity.tokenX.decimals, liquidity.tokenX.symbol) : "",
    liquidity.amountY !== "0" ? amount(liquidity.amountY, liquidity.tokenY.decimals, liquidity.tokenY.symbol) : "",
  ];
  return parts.filter(Boolean).join(" + ");
}

export function actionTitle(action: PendingAction): string {
  switch (action.kind) {
    case "swap":
      return `Swap ${amount(action.amountBaseUnits, action.input.decimals, action.input.symbol)} → ${escapeHtml(action.output.symbol)}`;
    case "dlmmClaim":
      return `Claim fees from the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmRemove":
      return `Remove ${action.bps / 100}% of the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmZapOut":
      return `Zap out the ${escapeHtml(action.pairLabel)} position to ${escapeHtml(action.depositSymbol)}`;
    case "closeStrategy":
      return `Close the empty ${escapeHtml(action.label)}`;
    case "dlmmAdd":
      return `Add ${liquidityAmounts(action.liquidity)} to the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmOpen":
      return `Open a ${escapeHtml(action.pairLabel)} position with ${liquidityAmounts(action.liquidity)}`;
    case "dlmmInit":
      return `Create an empty ${escapeHtml(action.pairLabel)} position`;
    case "dlmmClose":
      return `Close the ${escapeHtml(action.pairLabel)} position`;
    case "jupiterInit":
      return `Track ${escapeHtml(action.token.symbol)} (open its swap strategy)`;
    case "phoenixInit":
      return "Set up the Phoenix strategy";
    case "phoenixOnboard":
      return "Onboard the vault's Phoenix trader";
    case "phoenixDeposit":
      return `Deposit ${usdcAmount(action.amountBaseUnits)} into Phoenix`;
    case "phoenixWithdraw":
      return `Withdraw ${usdcAmount(action.amountBaseUnits)} from Phoenix`;
    case "phoenixOrder": {
      const { order } = action;
      const how = order.order.type === "market" ? "at market" : `limit at $${escapeHtml(order.order.price)}`;
      return `${order.side === "long" ? "Long" : "Short"} ${escapeHtml(order.size)} ${escapeHtml(order.symbol)} ${how}`;
    }
    case "phoenixCancel":
      return `Cancel all open ${escapeHtml(action.symbol)} orders`;
    case "phoenixSweep":
      return "Sweep Phoenix withdrawals into USDC";
    case "vaultCreate":
      return `Create the vault "${escapeHtml(action.name)}"`;
    case "vaultUpdate":
      return "Update vault settings";
    case "vaultClaimFee":
      return "Claim the manager fee";
    case "vaultClose":
      return "Close this vault";
  }
}

const STATUS_WORDS: Record<VaultStatus, string> = { normal: "Normal", reduceOnly: "Reduce-only", paused: "Paused" };

function changeLines(changes: VaultChanges, deposit: TokenRef): string[] {
  const lines: string[] = [];
  if (changes.status !== undefined) lines.push(`Status → <b>${STATUS_WORDS[changes.status]}</b>`);
  if (changes.depositPaused !== undefined) lines.push(`Deposits → <b>${changes.depositPaused ? "paused" : "open"}</b>`);
  if (changes.withdrawalPaused !== undefined) lines.push(`Withdrawals → <b>${changes.withdrawalPaused ? "paused" : "open"}</b>`);
  if (changes.performanceFeeBps !== undefined) lines.push(`Performance fee → <b>${feePercent(changes.performanceFeeBps)}</b>`);
  if (changes.managementFeeBps !== undefined) lines.push(`Management fee → <b>${feePercent(changes.managementFeeBps)}</b> a year`);
  if (changes.depositCap !== undefined) lines.push(`Deposit cap → <b>${cap(changes.depositCap, deposit)}</b>`);
  if (changes.minDeposit !== undefined) lines.push(`Min deposit → <b>${amount(changes.minDeposit, deposit.decimals, deposit.symbol)}</b>`);
  if (changes.minWithdrawalShares !== undefined) lines.push(`Min withdrawal → <b>${shares(changes.minWithdrawalShares, deposit.decimals)}</b>`);
  return lines;
}

function paramLines(params: VaultParams, deposit: TokenRef): string[] {
  return [
    `Performance fee ${feePercent(params.performanceFeeBps)} · management fee ${feePercent(params.managementFeeBps)} a year`,
    `Deposit cap ${cap(params.depositCap, deposit)}`,
    `Min deposit ${amount(params.minDeposit, deposit.decimals, deposit.symbol)} · min withdrawal ${shares(params.minWithdrawalShares, deposit.decimals)}`,
  ];
}

/** `vault` is unset only when creating one. */
export function confirmMessage(vault: VaultSummary | undefined, action: PendingAction, quote?: Quote): string {
  const lines = [`⚠️ <b>Confirm</b>${vault ? ` · ${escapeHtml(vault.name)}` : ""}`, "", `<b>${actionTitle(action)}</b>`];
  if (action.kind === "swap" && quote) {
    lines.push(
      `You get <b>≈ ${amount(quote.outAmount, action.output.decimals, action.output.symbol)}</b> (fresh quote)`,
      `Slippage limit ${action.slippageBps / 100}% · price impact ${escapeHtml(quote.priceImpactPct)}%`,
    );
  }
  if (action.kind === "swap" && action.unverified) {
    lines.push("<blockquote>⚠️ Jupiter has not verified this token. Check the contract address before you confirm.</blockquote>");
  }
  if (action.kind === "dlmmRemove" && action.bps === 10_000) lines.push("<i>Tokens return to the vault; the empty position stays open.</i>");
  if (action.kind === "dlmmOpen") {
    const bins = action.upperBinId - action.lowerBinId;
    const transactions = Math.ceil(bins / DLMM_BINS_PER_TRANSACTION);
    lines.push(
      `Range ${escapeHtml(action.priceRange.low)} to ${escapeHtml(action.priceRange.high)} · ${bins} bins · ${shapeLabel(action.liquidity.shape)}`,
      `<i>${transactions > 1 ? `About ${transactions} transactions. ` : ""}Creating the position costs a small refundable SOL rent from the manager wallet.</i>`,
    );
  }
  if (action.kind === "dlmmAdd") lines.push(`<i>${shapeLabel(action.liquidity.shape)} shape across the position's existing range.</i>`);
  if (action.kind === "dlmmZapOut") lines.push("<i>Removes all liquidity, claims fees, swaps to the deposit token, and closes the position. Large positions take several transactions.</i>");
  switch (action.kind) {
    case "dlmmInit":
      lines.push(
        `Range ${escapeHtml(action.priceRange.low)} to ${escapeHtml(action.priceRange.high)} · ${action.upperBinId - action.lowerBinId} bins`,
        "<i>Adds no liquidity. Creating the position costs a small refundable SOL rent from the manager wallet.</i>",
      );
      break;
    case "dlmmClose":
      lines.push("<blockquote>⚠️ This removes all of the position's liquidity, claims its fees back to the vault, and closes it. Large positions take several transactions.</blockquote>");
      break;
    case "jupiterInit":
      lines.push(address(action.token.mint), "<i>Lets the vault hold and swap this token.</i>");
      if (action.verified !== true) lines.push("<blockquote>⚠️ Jupiter has not verified this token. Check the contract address before you confirm.</blockquote>");
      break;
    case "phoenixWithdraw":
      lines.push("<i>If Phoenix queues the withdrawal, tap 🧹 Sweep once it arrives to turn it into USDC.</i>");
      break;
    case "phoenixOrder": {
      const { order } = action;
      if (order.order.type === "market") lines.push(`Slippage limit ${order.order.slippageBps / 100}% around the mark price`);
      else if (order.order.postOnly) lines.push("Post-only: cancelled instead of filling right away");
      if (order.reduceOnly) lines.push("Reduce-only: can only shrink an open position");
      break;
    }
    case "vaultCreate":
      lines.push(
        `Deposit token <b>${escapeHtml(action.deposit.symbol)}</b> ${address(action.deposit.mint)}`,
        ...paramLines(action, action.deposit),
        "<i>Your active wallet becomes the vault's manager. The deposit token cannot change later.</i>",
      );
      break;
    case "vaultUpdate":
      lines.push(...changeLines(action.changes, action.deposit));
      if (action.changes.status === "paused") {
        lines.push("<blockquote>⚠️ Paused stops depositors from withdrawing, and blocks deposits and trading, until you set the vault back to Normal.</blockquote>");
      }
      if (action.changes.status === "reduceOnly") lines.push("<i>Reduce-only blocks new deposits and new trades. Withdrawals still work.</i>");
      if (action.changes.performanceFeeBps !== undefined || action.changes.managementFeeBps !== undefined) {
        lines.push("<i>New fees may take effect only after a waiting period. ⚙️ Settings shows when.</i>");
      }
      break;
    case "vaultClaimFee":
      lines.push("<i>Mints the manager's accrued fee shares to your wallet.</i>");
      break;
    case "vaultClose":
      lines.push(
        "<blockquote>⚠️ Closing deletes this vault for good. Nobody can deposit into it again. It only works once no shares, pending requests, unclaimed fees, open strategies, or assets remain.</blockquote>",
      );
      break;
    default:
      break;
  }
  lines.push("", `<blockquote>This signs and sends a real Solana mainnet transaction from ${vault ? "the vault" : "your manager wallet"}. It cannot be undone.</blockquote>`);
  return lines.join("\n");
}

function progressLine(progress: Progress): string {
  switch (progress.kind) {
    case "building":
      return `🛠 Building <code>${escapeHtml(progress.action)}</code>`;
    case "sent":
      return `📤 Sent ${txLink(progress.signature)}${progress.status === "unknown" ? " <i>(outcome unknown, checking)</i>" : ""}`;
    case "confirmed":
      return `✅ Confirmed ${txLink(progress.signature)}`;
  }
}

/** Live view while an action runs; `outcome` appears once it ends. */
export function executionMessage(action: PendingAction, progress: Progress[], outcome?: Outcome, scope?: string): string {
  const lines = [`${outcome ? outcomeIcon(outcome) : "⏳"} <b>${actionTitle(action)}</b>`, "", ...progress.map(progressLine)];
  if (!outcome) return [...lines, "", "<i>Working… keep this chat open.</i>"].join("\n");
  lines.push("");
  switch (outcome.kind) {
    case "confirmed":
      lines.push(`<b>Done.</b> ${outcome.signatures.length} transaction(s) confirmed.`);
      if (outcome.created?.vault) lines.push(`New vault ${address(outcome.created.vault)}`);
      if (outcome.created?.position) lines.push(`New position ${address(outcome.created.position)}`);
      break;
    case "refused":
      lines.push("<b>Not signed.</b> The bot refused a transaction from the API:", `<i>${escapeHtml(outcome.reason)}</i>`);
      break;
    case "failed":
      lines.push(`<b>Failed</b> (${escapeHtml(outcome.code)}): ${escapeHtml(outcome.message)}`);
      {
        const hint = errorHint(outcome.code, outcome.message, scope);
        if (hint) lines.push(`<i>${escapeHtml(hint)}</i>`);
      }
      if (outcome.signature) lines.push(`Transaction ${txLink(outcome.signature)}`);
      if (outcome.signatures.length > 0) lines.push("<i>Earlier transactions in this action already landed. Check the position before retrying.</i>");
      break;
    case "unresolved":
      lines.push(
        "<b>Outcome unknown.</b> These may still land:",
        ...outcome.pending.map((signature) => `• ${txLink(signature)}`),
        "<i>Check Solscan before trying again. Do not resend blindly.</i>",
      );
      break;
  }
  return lines.join("\n");
}

const outcomeIcon = (outcome: Outcome) => ({ confirmed: "✅", refused: "🛑", failed: "❌", unresolved: "❓" })[outcome.kind];

const tokenLabel = (token: TokenRef & { pasted?: boolean; verified?: boolean | null }) =>
  `<b>${escapeHtml(token.symbol)}</b>${"pasted" in token && token.pasted ? ` ${address(token.mint)}` : ""}`;

export function swapFormMessage(form: SwapForm, inputBalanceBaseUnits: string | undefined): string {
  const lines = [`💱 <b>Swap</b> · ${form.side === "buy" ? "buy with" : "sell for"} ${escapeHtml(form.deposit.symbol)}`, ""];
  lines.push(`Token ${form.token ? tokenLabel(form.token) : "<i>not set: pick one or paste a contract address</i>"}`);
  if (form.token && needsWarning(form.token)) lines.push(`⚠️ <i>${form.token.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  const input = form.token ? (form.side === "buy" ? form.deposit : form.token) : undefined;
  lines.push(`Amount ${escapeHtml(describeAmount(form.amount, input, (base, decimals) => amount(base, decimals, "").trim()))}`);
  if (input && inputBalanceBaseUnits !== undefined) lines.push(`Vault ${escapeHtml(input.symbol)} ${amount(inputBalanceBaseUnits, input.decimals, input.symbol)}`);
  lines.push(`Slippage ${form.slippageBps / 100}%`);
  return lines.join("\n");
}

export function swapQuoteMessage(form: SwapForm, tokens: { input: TokenRef; output: TokenRef }, amountBaseUnits: string, quote: Quote): string {
  const lines = [
    `💱 <b>${escapeHtml(tokens.input.symbol)} → ${escapeHtml(tokens.output.symbol)}</b>`,
    "",
    `You give <b>${amount(amountBaseUnits, tokens.input.decimals, tokens.input.symbol)}</b>`,
    `You get  <b>≈ ${amount(quote.outAmount, tokens.output.decimals, tokens.output.symbol)}</b>`,
    "",
    `Price impact ${escapeHtml(quote.priceImpactPct)}% · slippage ${quote.slippageBps / 100}%`,
    `Route ${quote.routeLabels.map(escapeHtml).join(" → ") || "unknown"}`,
  ];
  if (form.token && needsWarning(form.token)) lines.push("", "⚠️ <i>This token is not Jupiter-verified. Check the contract address.</i>");
  lines.push("", "<i>A quote is not a promise. The trade can still fail or price differently.</i>");
  return lines.join("\n");
}

export function lpFormMessage(form: LpForm, range: PriceRange | string | undefined, balances: { x: string; y: string } | undefined): string {
  const pool = form.pool;
  const lines = [form.mode === "add" ? "➕ <b>Add liquidity</b>" : "➕ <b>New LP position</b>", ""];
  if (!pool) {
    lines.push(`Pool <i>not set: paste a pool address or search, e.g. "SOL"</i>`, `<i>The pool must include ${escapeHtml(form.deposit.symbol)}.</i>`);
    if (form.poolChoices?.length) lines.push("", "<i>Matches:</i>");
    return lines.join("\n");
  }
  lines.push(
    `Pool <b>${escapeHtml(pool.tokenX.symbol)}/${escapeHtml(pool.tokenY.symbol)}</b> · ${pool.binStep} bps bins`,
    `Price now <b>${escapeHtml(pool.activePrice)}</b> ${escapeHtml(pool.tokenY.symbol)} per ${escapeHtml(pool.tokenX.symbol)}`,
    `Shape ${shapeLabel(form.shape)}`,
  );
  if (form.mode === "open") {
    lines.push(`Min ${form.minPrice === undefined ? "?" : formatPrice(form.minPrice)} · Max ${form.maxPrice === undefined ? "?" : formatPrice(form.maxPrice)}`);
    if (typeof range === "string") lines.push(`⚠️ <i>${escapeHtml(range)}</i>`);
    else if (range) {
      const holds = range.sides === "both" ? "both tokens" : `only ${escapeHtml(range.sides === "x" ? pool.tokenX.symbol : pool.tokenY.symbol)}`;
      lines.push(`<i>${range.binCount} bins, ${formatPrice(range.lowPrice)} to ${formatPrice(range.highPrice)}; holds ${holds}.</i>`);
    }
  }
  lines.push(
    "",
    `${escapeHtml(pool.tokenX.symbol)} ${escapeHtml(describeAmount(form.amountX, pool.tokenX, (base, decimals) => amount(base, decimals, "").trim()))}${balances ? ` · vault has ${amount(balances.x, pool.tokenX.decimals, pool.tokenX.symbol)}` : ""}`,
    `${escapeHtml(pool.tokenY.symbol)} ${escapeHtml(describeAmount(form.amountY, pool.tokenY, (base, decimals) => amount(base, decimals, "").trim()))}${balances ? ` · vault has ${amount(balances.y, pool.tokenY.decimals, pool.tokenY.symbol)}` : ""}`,
  );
  return lines.join("\n");
}

export function phoenixTransferFormMessage(form: PhoenixTransferForm): string {
  const lines = [
    form.direction === "deposit" ? "💵 <b>Deposit USDC into Phoenix</b>" : "📤 <b>Withdraw from Phoenix</b>",
    "",
    `Amount ${escapeHtml(describeAmount(form.amount, form.usdc, (base, decimals) => amount(base, decimals, "").trim()))}`,
    form.direction === "deposit" ? "<i>Shares are of the vault's idle USDC.</i>" : "<i>Shares are of what Phoenix reports as withdrawable.</i>",
  ];
  return lines.join("\n");
}

export function orderFormMessage(form: OrderForm): string {
  const market = form.markets.find((m) => m.symbol === form.symbol);
  const lines = [
    "🆕 <b>Phoenix order</b>",
    "",
    `Market ${market ? `<b>${escapeHtml(market.symbol)}</b>${market.markPrice === "0" ? " · no mark price" : ` · mark $${escapeHtml(market.markPrice)}`}` : "<i>not set: tap a market</i>"}`,
    `Side ${form.side === "long" ? "🟢 long" : "🔴 short"}`,
    `Size ${form.size ? `${escapeHtml(form.size)}${market ? ` ${escapeHtml(market.symbol)}` : ""}` : "<i>not set</i>"}`,
    form.type === "market"
      ? `Market order · slippage ${form.slippageBps / 100}%`
      : `Limit order at ${form.price ? `$${escapeHtml(form.price)}` : "<i>price not set</i>"} · post-only ${form.postOnly ? "on" : "off"}`,
    `Reduce-only ${form.reduceOnly ? "on" : "off"}`,
  ];
  return lines.join("\n");
}

export function vaultFormMessage(form: VaultForm): string {
  const lines = [form.vault ? `✏️ <b>${escapeHtml(form.name ?? "Vault")}</b> · fees and limits` : "✨ <b>New vault</b>", ""];
  if (!form.vault) {
    lines.push(`Name ${form.name ? `<b>${escapeHtml(form.name)}</b>` : "<i>not set</i>"}`, `Deposit token ${tokenLabel(form.deposit)}`);
    if (needsWarning(form.deposit)) lines.push(`⚠️ <i>${form.deposit.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  }
  lines.push(...paramLines(form.params, form.deposit));
  if (form.vault && form.current) {
    const changed = changeLines(vaultChanges(form.params, form.current), form.deposit);
    lines.push("", changed.length ? "<b>Will change</b>" : "<i>Nothing changed yet.</i>", ...changed);
  }
  return lines.join("\n");
}

export function trackFormMessage(form: TrackForm): string {
  const lines = ["➕ <b>Track a token</b>", "", `Token ${form.token ? tokenLabel(form.token) : "<i>not set: paste a contract address</i>"}`];
  if (form.token && needsWarning(form.token)) lines.push(`⚠️ <i>${form.token.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  else if (form.token) lines.push("✅ <i>Verified by Jupiter.</i>");
  lines.push("", "<i>Opens a swap strategy so the vault can hold this token.</i>");
  return lines.join("\n");
}

/** The API redacts 5xx messages; these codes are specific enough to say what to do next. */
const ERROR_HINTS: Record<string, string> = {
  JupiterUnsupportedCpiRoute: "Jupiter picked a route the vault program cannot run. Try a different amount or token, or try again shortly.",
  JupiterQuoteFailed: "Jupiter could not quote right now. Try again in a moment.",
  JupiterSwapFailed: "Jupiter could not build the swap right now. Try again in a moment.",
  RateLimited: "Too many requests. Wait a minute and try again.",
  InvalidTicket: "The build expired before it was sent. Start the action again.",
  Expired: "The transaction expired before it landed. It did not execute; you can try again.",
  PhoenixAlreadyOnboarded: "The vault's Phoenix trader is already onboarded. Open 📈 Phoenix again to deposit and trade.",
  PhoenixNoMark: "Phoenix has no mark price for this market right now. Try again shortly, or use a limit order.",
  HistoryUnavailable: "This server keeps no history database, so history is not available.",
  InvalidBasisPoints: "A fee must be between 0% and 100%.",
  InvalidMinimumAmount: "The minimum deposit and minimum withdrawal must both be more than zero.",
  VaultHasOutstandingShares: "Depositors still hold shares. The vault can close only after every share is withdrawn.",
  VaultHasPendingRequests: "Deposits or withdrawals are still queued. Wait for them to settle or be cancelled.",
  VaultHasUnclaimedFees: "Fees are still unclaimed. Claim the manager fee first; the platform fee must be claimed by the admin.",
  VaultHasOpenStrategies: "Strategies are still open. Close every strategy first.",
  VaultHasAssets: "The vault still holds assets. It can close only when empty.",
};

/** API 403 messages that a missing key setting causes, with the fix an admin makes. */
function forbiddenHint(message: string, scope: string | undefined): string | undefined {
  if (message === "Action is not enabled for this key") {
    return scope
      ? `This API key may not do "${scope}". Ask an admin to enable "${scope}"${scope === "read" ? "" : ' and "send"'} for this key in the dashboard.`
      : "This API key is missing a permission. Ask an admin to check its actions in the dashboard.";
  }
  if (message === "Vault creation requires a key without a vault restriction") {
    return 'Creating a vault needs an API key that is not limited to specific vaults. Ask an admin for one with "vault/initialize" and "send".';
  }
  if (message === "Vault is outside key scope") return "This API key is limited to other vaults. Ask an admin to add this vault to the key.";
  return undefined;
}

/** Plain words for an API error code. `scope` is the key action the request needed, e.g. "phoenix/order". */
export const errorHint = (code: string, message = "", scope?: string): string | undefined =>
  code === "Forbidden" ? forbiddenHint(message, scope) : ERROR_HINTS[code];

export function errorMessage(title: string, detail?: string): string {
  return detail ? `❌ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}` : `❌ ${escapeHtml(title)}`;
}
