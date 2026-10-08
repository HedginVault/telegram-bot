/**
 * Range widths offered for a new position. A Meteora position holds up to 70 bins in one
 * account; staying under it keeps `dlmm/open` to a single transaction.
 * ponytail: single-sided spot ranges only; add two-sided and custom ranges when someone needs them.
 */
export const LP_WIDTHS = [10, 30, 69] as const;
export type LpWidth = (typeof LP_WIDTHS)[number];

export interface BinRange {
  lowerBinId: number;
  /** Exclusive, as `dlmm/open` expects. */
  upperBinId: number;
}

/**
 * Single-sided liquidity sits on one side of the price: token X in bins at and above the
 * active bin, token Y at and below it. The range always includes the active bin.
 */
export function singleSidedRange(activeBinId: number, width: LpWidth, depositIsX: boolean): BinRange {
  return depositIsX
    ? { lowerBinId: activeBinId, upperBinId: activeBinId + width }
    : { lowerBinId: activeBinId - width + 1, upperBinId: activeBinId + 1 };
}

/** Token Y per token X at `binId`, for display. Bin prices grow by `binStep` basis points per bin. */
export function binPrice(activePrice: number, activeBinId: number, binStep: number, binId: number): number {
  return activePrice * (1 + binStep / 10_000) ** (binId - activeBinId);
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "?";
  return price >= 1 ? price.toLocaleString("en-US", { maximumFractionDigits: 4 }) : price.toPrecision(4);
}

/** The display price range a bin range covers, lowest to highest (inclusive of the last bin). */
export function rangePrices(activePrice: number, activeBinId: number, binStep: number, range: BinRange): { low: string; high: string } {
  return {
    low: formatPrice(binPrice(activePrice, activeBinId, binStep, range.lowerBinId)),
    high: formatPrice(binPrice(activePrice, activeBinId, binStep, range.upperBinId - 1)),
  };
}

/** How far the range reaches from the current price, in percent, for button labels. */
export function rangeSpanPct(binStep: number, width: LpWidth): string {
  return `${(((1 + binStep / 10_000) ** (width - 1) - 1) * 100).toFixed(1)}%`;
}
