import type { Holdings, Outcome, PoolInfo, PoolSearchPage, Progress, Quote, Strategy, VaultSummary } from "@hedginvault/sdk";
import type { PendingAction } from "./actions";
import type { LpWidth } from "./lp";
import type { AmountPercent, QuotePair, TokenRef } from "./screens";
import { formatBaseUnits } from "./format";

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

const STATUS_LABEL: Record<string, string> = {
  normal: "🟢 normal",
  reduceOnly: "🟡 reduce only",
  paused: "🔴 paused",
};
const status = (value: string) => STATUS_LABEL[value] ?? `⚪ ${escapeHtml(value)}`;

export const HELP_MESSAGE = [
  "🤖 <b>Hedge Vault manager bot</b>",
  "",
  "Tap <b>Vaults</b> below and use the buttons. Commands also work:",
  "",
  "<b>Commands</b>",
  "/vaults · vaults this API key can manage",
  "/holdings &lt;vault&gt; · what a vault holds and is worth",
  "/strategies &lt;vault&gt; · open strategies",
  "/quote &lt;vault&gt; &lt;inputMint&gt; &lt;outputMint&gt; &lt;amount&gt; [slippageBps] · Jupiter quote",
  "",
  "<b>Tips</b>",
  "• &lt;vault&gt; is a number from /vaults or an address. /holdings and /strategies also take the vault name.",
  "• &lt;amount&gt; is in base units: 1 USDC = <code>1000000</code>.",
  "• Tap an address to copy it.",
  "• Quote buttons stop working when the bot restarts. Send /start for fresh ones.",
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

export function quoteMessage(quote: Quote): string {
  return [
    "💱 <b>Jupiter quote</b>",
    "",
    `In  <code>${quote.inAmount}</code> base units`,
    `Out <code>${quote.outAmount}</code> base units`,
    `Price impact ${escapeHtml(quote.priceImpactPct)}% · slippage ${quote.slippageBps} bps`,
    `Route ${quote.routeLabels.map(escapeHtml).join(" → ") || "unknown"}`,
    "",
    "<i>A quote is not a promise. The trade can still fail or price differently.</i>",
  ].join("\n");
}

export function quotePickMessage(vault: VaultSummary, depositSymbol: string, tokenCount: number): string {
  const title = `💱 <b>${escapeHtml(vault.name)}</b> · quote a swap`;
  if (tokenCount === 0) {
    return [
      title,
      "",
      `This vault holds only ${escapeHtml(depositSymbol)}, so there is nothing to pick here.`,
      "<i>For any other token, type /quote with its mint address.</i>",
    ].join("\n");
  }
  return [
    title,
    "",
    `Every swap trades against the deposit token, ${escapeHtml(depositSymbol)}.`,
    "<i>Pick a token the vault holds:</i>",
  ].join("\n");
}

export function quoteAmountMessage(pair: QuotePair): string {
  return [
    `💱 <b>${escapeHtml(pair.input.symbol)} → ${escapeHtml(pair.output.symbol)}</b>`,
    "",
    `Vault balance <b>${amount(pair.inputBalanceBaseUnits, pair.input.decimals, pair.input.symbol)}</b>`,
    "<i>How much of it should the quote use?</i>",
  ].join("\n");
}

export function quoteResultMessage(pair: QuotePair, percent: AmountPercent, quote: Quote | undefined): string {
  const title = `💱 <b>${escapeHtml(pair.input.symbol)} → ${escapeHtml(pair.output.symbol)}</b> · ${percent}% of balance`;
  if (!quote) return [title, "", `The vault holds no ${escapeHtml(pair.input.symbol)} to quote.`].join("\n");
  return [
    title,
    "",
    `You give <b>${amount(quote.inAmount, pair.input.decimals, pair.input.symbol)}</b>`,
    `You get  <b>≈ ${amount(quote.outAmount, pair.output.decimals, pair.output.symbol)}</b>`,
    "",
    `Price impact ${escapeHtml(quote.priceImpactPct)}% · slippage ${quote.slippageBps} bps`,
    `Route ${quote.routeLabels.map(escapeHtml).join(" → ") || "unknown"}`,
    "",
    "<i>A quote is not a promise. The trade can still fail or price differently.</i>",
  ].join("\n");
}

type DlmmStrategy = Extract<Strategy, { type: "dlmm" }>;

export function positionMessage(vault: VaultSummary, strategy: DlmmStrategy, trading: boolean): string {
  const { tokenX, tokenY } = strategy;
  const lines = [
    `⚙️ <b>${escapeHtml(tokenX.symbol)}/${escapeHtml(tokenY.symbol)} position</b> · ${escapeHtml(vault.name)}`,
    address(strategy.position),
    "",
    `Range ${escapeHtml(strategy.lowerPrice)} to ${escapeHtml(strategy.upperPrice)} · now <b>${escapeHtml(strategy.activePrice)}</b>`,
    `Holds ${amount(strategy.amountX, tokenX.decimals, tokenX.symbol)} + ${amount(strategy.amountY, tokenY.decimals, tokenY.symbol)}`,
    `Unclaimed fees ${amount(strategy.pendingFeeX, tokenX.decimals, tokenX.symbol)} + ${amount(strategy.pendingFeeY, tokenY.decimals, tokenY.symbol)}`,
  ];
  if (!trading) lines.push("", "<i>Trading is off. Set MANAGER_KEYPAIR_PATH to manage this position.</i>");
  return lines.join("\n");
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
      return `Add ${amount(action.amounts.display.amountBaseUnits, action.amounts.display.token.decimals, action.amounts.display.token.symbol)} to the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmOpen":
      return `Open a ${escapeHtml(action.pairLabel)} position with ${amount(action.amounts.display.amountBaseUnits, action.amounts.display.token.decimals, action.amounts.display.token.symbol)}`;
  }
}

export function confirmMessage(vault: VaultSummary, action: PendingAction, quote?: Quote): string {
  const lines = [`⚠️ <b>Confirm</b> · ${escapeHtml(vault.name)}`, "", `<b>${actionTitle(action)}</b>`];
  if (action.kind === "swap" && quote) {
    lines.push(
      `You get <b>≈ ${amount(quote.outAmount, action.output.decimals, action.output.symbol)}</b> (fresh quote)`,
      `Slippage limit ${action.slippageBps} bps · price impact ${escapeHtml(quote.priceImpactPct)}%`,
    );
  }
  if (action.kind === "dlmmRemove" && action.bps === 10_000) lines.push("<i>Tokens return to the vault; the empty position stays open.</i>");
  if (action.kind === "dlmmOpen") {
    lines.push(
      `Range ${escapeHtml(action.priceRange.low)} to ${escapeHtml(action.priceRange.high)} · bins ${action.lowerBinId} to ${action.upperBinId - 1}`,
      "<i>Single-sided spot. Creating the position costs a small refundable SOL rent from the manager wallet.</i>",
    );
  }
  if (action.kind === "dlmmAdd") lines.push("<i>Spot shape across the position's existing range.</i>");
  if (action.kind === "dlmmZapOut") lines.push("<i>Removes all liquidity, claims fees, swaps to the deposit token, and closes the position. Large positions take several transactions.</i>");
  lines.push("", "<blockquote>This signs and sends a real Solana mainnet transaction from the vault. It cannot be undone.</blockquote>");
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
export function executionMessage(action: PendingAction, progress: Progress[], outcome?: Outcome): string {
  const lines = [`${outcome ? outcomeIcon(outcome) : "⏳"} <b>${actionTitle(action)}</b>`, "", ...progress.map(progressLine)];
  if (!outcome) return [...lines, "", "<i>Working… keep this chat open.</i>"].join("\n");
  lines.push("");
  switch (outcome.kind) {
    case "confirmed":
      lines.push(`<b>Done.</b> ${outcome.signatures.length} transaction(s) confirmed.`);
      break;
    case "refused":
      lines.push("<b>Not signed.</b> The bot refused a transaction from the API:", `<i>${escapeHtml(outcome.reason)}</i>`);
      break;
    case "failed":
      lines.push(`<b>Failed</b> (${escapeHtml(outcome.code)}): ${escapeHtml(outcome.message)}`);
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

const usdCompact = (value: number | null | undefined) =>
  value === null || value === undefined ? "?" : `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;

export function lpPoolsMessage(vault: VaultSummary, depositSymbol: string, pools: PoolSearchPage["pools"]): string {
  const title = `➕ <b>New LP position</b> · ${escapeHtml(vault.name)}`;
  if (pools.length === 0) return `${title}\n\nNo Meteora DLMM pool pairs with ${escapeHtml(depositSymbol)}.`;
  return [
    title,
    "",
    `Pools that pair with ${escapeHtml(depositSymbol)}:`,
    ...pools.map(
      (pool) =>
        `• <b>${escapeHtml(pool.tokenX.symbol)}/${escapeHtml(pool.tokenY.symbol)}</b> · ${pool.binStep} bps bins · TVL ${usdCompact(pool.tvl)} · 24h fees ${usdCompact(pool.fees24h)}`,
    ),
    "",
    "<i>Pick one:</i>",
  ].join("\n");
}

export function lpRangeMessage(pool: PoolInfo, depositSymbol: string, depositIsX: boolean): string {
  return [
    `➕ <b>${escapeHtml(pool.tokenX.symbol)}/${escapeHtml(pool.tokenY.symbol)}</b> · ${pool.binStep} bps bins`,
    `Price now <b>${escapeHtml(pool.activePrice)}</b> ${escapeHtml(pool.tokenY.symbol)} per ${escapeHtml(pool.tokenX.symbol)}`,
    "",
    `Your ${escapeHtml(depositSymbol)} goes ${depositIsX ? "at and above" : "at and below"} the current price, so it ${depositIsX ? "sells into" : "buys"} ${escapeHtml(depositIsX ? pool.tokenY.symbol : pool.tokenX.symbol)} as the price ${depositIsX ? "rises" : "falls"}.`,
    "<i>How wide should the range be?</i>",
  ].join("\n");
}

export function lpAmountMessage(pool: PoolInfo, deposit: TokenRef, balanceBaseUnits: string, priceRange: { low: string; high: string }, width: LpWidth): string {
  const lines = [
    `➕ <b>${escapeHtml(pool.tokenX.symbol)}/${escapeHtml(pool.tokenY.symbol)}</b> · ${width} bins`,
    `Range ${escapeHtml(priceRange.low)} to ${escapeHtml(priceRange.high)}`,
    "",
    `Vault ${escapeHtml(deposit.symbol)} <b>${amount(balanceBaseUnits, deposit.decimals, deposit.symbol)}</b>`,
  ];
  lines.push(balanceBaseUnits === "0" ? "<i>The vault has no idle deposit token to add.</i>" : "<i>How much of it should the position get?</i>");
  return lines.join("\n");
}

export function errorMessage(title: string, detail?: string): string {
  return detail ? `❌ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}` : `❌ ${escapeHtml(title)}`;
}
