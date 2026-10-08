import type { Holdings, Quote, Strategy, VaultSummary } from "../src/api";

export const VAULT = "Vau1t1111111111111111111111111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL = "So11111111111111111111111111111111111111112";

export const vaultSummary: VaultSummary = {
  address: VAULT,
  name: "Demo",
  status: "normal",
  depositSymbol: "USDC",
  depositDecimals: 6,
  totalAssets: "1500000",
};

export const holdings: Holdings = {
  depositToken: { mint: USDC, symbol: "USDC", decimals: 6 },
  totalValue: "2500000",
  totalUsd: 2.5,
  navTotalAssets: "2400000",
  navDeltaBps: 417,
  partial: true,
  unpriced: ["MYSTERY"],
  tokens: [
    { token: { mint: USDC, symbol: "USDC", decimals: 6 }, amount: "1000000", usd: 1, shareBps: 4000 },
    { token: { mint: SOL, symbol: "SOL", decimals: 9 }, amount: "10000000", usd: 1.5, shareBps: 6000 },
  ],
};

export const strategies: Strategy[] = [
  { type: "jupiter", address: "Strat1", symbol: "SOL", decimals: 9, vaultBalance: "10000000" },
  {
    type: "dlmm",
    address: "Strat2",
    position: "Pos1111111111111111111111111111111111111111",
    tokenX: { mint: SOL, symbol: "SOL", decimals: 9 },
    tokenY: { mint: USDC, symbol: "USDC", decimals: 6 },
    lowerPrice: "140",
    upperPrice: "160",
    activePrice: "150",
    amountX: "500000000",
    amountY: "75000000",
  },
  { type: "phoenix", address: "Strat3", equity: "12345678", leverage: null },
  { type: "unreadable", address: "Strat4444444444444444444444444444444444444", protocol: "dlmm", reason: "position account missing" },
];

export const quote: Quote = {
  inAmount: "1000000",
  outAmount: "6666666",
  priceImpactPct: "0.01",
  routeLabels: ["Meteora DLMM", "Whirlpool"],
  slippageBps: 50,
};
