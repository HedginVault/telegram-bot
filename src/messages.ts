import type { Holdings, Quote, Strategy, VaultSummary } from "./api";
import type { AmountPercent, QuotePair } from "./screens";
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

export function errorMessage(title: string, detail?: string): string {
  return detail ? `❌ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}` : `❌ ${escapeHtml(title)}`;
}
