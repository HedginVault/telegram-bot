import type { Holdings, Quote, Strategy, VaultSummary } from "./api";
import { formatBaseUnits, shortAddress } from "./format";

const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Telegram rejects longer messages outright, so trim instead of failing the reply. */
export function fitMessage(text: string): string {
  const marker = "\n… (truncated)";
  return text.length <= TELEGRAM_MESSAGE_LIMIT ? text : text.slice(0, TELEGRAM_MESSAGE_LIMIT - marker.length) + marker;
}

const usd = (value: number | null) => (value === null ? "no price" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const percent = (bps: number | null) => (bps === null ? "?" : `${(bps / 100).toFixed(2)}%`);

export function vaultsMessage(vaults: VaultSummary[]): string {
  if (vaults.length === 0) return "This API key has no vaults in scope.";
  return vaults
    .map(
      (vault, index) =>
        `${index + 1}. ${vault.name} (${vault.status})\n${vault.address}\nTVL ${formatBaseUnits(vault.totalAssets, vault.depositDecimals)} ${vault.depositSymbol}`,
    )
    .join("\n\n");
}

export function holdingsMessage(vault: VaultSummary, holdings: Holdings): string {
  const deposit = holdings.depositToken;
  const lines = [
    `${vault.name} holdings`,
    `Live value: ${formatBaseUnits(holdings.totalValue, deposit.decimals)} ${deposit.symbol} (${usd(holdings.totalUsd)})`,
    `Last NAV: ${formatBaseUnits(holdings.navTotalAssets, deposit.decimals)} ${deposit.symbol} (live vs NAV ${percent(holdings.navDeltaBps)})`,
  ];
  if (holdings.partial) lines.push(`Partial view: no price for ${holdings.unpriced.join(", ") || "some tokens"}. Missing value is not zero.`);
  lines.push("");
  for (const exposure of holdings.tokens) {
    lines.push(
      `${exposure.token.symbol}: ${formatBaseUnits(exposure.amount, exposure.token.decimals)} (${usd(exposure.usd)}, ${percent(exposure.shareBps)})`,
    );
  }
  return lines.join("\n");
}

function strategyLine(strategy: Strategy): string {
  switch (strategy.type) {
    case "jupiter":
      return `Swap: ${formatBaseUnits(strategy.vaultBalance, strategy.decimals)} ${strategy.symbol}`;
    case "dlmm":
      return [
        `Meteora DLMM ${strategy.tokenX.symbol}/${strategy.tokenY.symbol} (position ${shortAddress(strategy.position)})`,
        `  Range ${strategy.lowerPrice} to ${strategy.upperPrice}, now ${strategy.activePrice}`,
        `  Holds ${formatBaseUnits(strategy.amountX, strategy.tokenX.decimals)} ${strategy.tokenX.symbol} + ${formatBaseUnits(strategy.amountY, strategy.tokenY.decimals)} ${strategy.tokenY.symbol}`,
      ].join("\n");
    case "phoenix":
      // Phoenix equity is in USDC atoms (6 decimals).
      return `Phoenix perps: equity ${formatBaseUnits(strategy.equity, 6)} USDC, leverage ${strategy.leverage === null ? "n/a" : `${strategy.leverage.toFixed(2)}x`}`;
    case "unreadable":
      return `${strategy.protocol} strategy ${shortAddress(strategy.address)} could not be read: ${strategy.reason}`;
  }
}

export function strategiesMessage(vault: VaultSummary, strategies: Strategy[]): string {
  if (strategies.length === 0) return `${vault.name} has no open strategies.`;
  return [`${vault.name} strategies`, "", ...strategies.map(strategyLine)].join("\n");
}

export function quoteMessage(quote: Quote): string {
  return [
    "Jupiter quote (base units)",
    `In: ${quote.inAmount}`,
    `Out: ${quote.outAmount}`,
    `Price impact: ${quote.priceImpactPct}%`,
    `Slippage: ${quote.slippageBps} bps`,
    `Route: ${quote.routeLabels.join(" > ") || "unknown"}`,
    "",
    "A quote is not a promise. The trade can still fail or price differently.",
  ].join("\n");
}
