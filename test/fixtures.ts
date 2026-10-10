import type { Holdings, NavHistoryPoint, PhoenixManager, PoolInfo, PoolSearchPage, Quote, RequestQueue, Strategy, StrategyHistoryItem, VaultDetail, VaultSummary } from "@hedginvault/sdk";

export const VAULT = "Vau1t111111111111111111111111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL = "So11111111111111111111111111111111111111112";

export const vaultSummary: VaultSummary = {
  address: VAULT,
  name: "Demo",
  status: "normal",
  depositMint: USDC,
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
    pendingFeeX: "1000000",
    pendingFeeY: "250000",
    lowerBinId: -110,
    upperBinId: -90,
    activeBinId: -100,
    binStep: 10,
    bins: [
      { binId: -102, amountX: "0", amountY: "25000000" },
      { binId: -101, amountX: "0", amountY: "25000000" },
      { binId: -100, amountX: "100000000", amountY: "25000000" },
      { binId: -99, amountX: "200000000", amountY: "0" },
      { binId: -98, amountX: "200000000", amountY: "0" },
    ],
  },
  { type: "phoenix", address: "Strat3", equity: "12345678", leverage: null },
  { type: "unreadable", address: "Strat4444444444444444444444444444444444444", protocol: "dlmm", reason: "position account missing" },
];

export const POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";
export const pool: PoolInfo = {
  lbPair: POOL,
  tokenX: { mint: SOL, symbol: "SOL", decimals: 9 },
  tokenY: { mint: USDC, symbol: "USDC", decimals: 6 },
  binStep: 10,
  activeBinId: -100,
  activePrice: "150",
};
export const SMALL_POOL = "SmaLLPooL1111111111111111111111111111111111";
export const poolSearch: PoolSearchPage = {
  total: 3,
  page: 1,
  pages: 1,
  // The API's order, not TVL order.
  pools: [
    { address: SMALL_POOL, name: "SOL-USDC", tokenX: pool.tokenX, tokenY: pool.tokenY, binStep: 80, tvl: 3400, fees24h: null, volume24h: null, baseFeePct: null },
    { address: POOL, name: "SOL-USDC", tokenX: pool.tokenX, tokenY: pool.tokenY, binStep: 10, tvl: 1_250_000, fees24h: 3400, volume24h: 340_000, baseFeePct: 0.1 },
    { address: "Other1111111111111111111111111111111111111", name: "SOL-BONK", tokenX: pool.tokenX, tokenY: { mint: "Bonk111111111111111111111111111111111111111", symbol: "BONK", decimals: 5 }, binStep: 80 },
  ],
};

export const quote: Quote = {
  inAmount: "1000000",
  outAmount: "6666666",
  priceImpactPct: "0.01",
  routeLabels: ["Meteora DLMM", "Whirlpool"],
  slippageBps: 50,
};

export const vaultDetail: VaultDetail = {
  ...vaultSummary,
  status: "normal",
  id: "7",
  navPerShare: "1020000000",
  depositCap: "1000000000",
  performanceFeeBps: 1000,
  managementFeeBps: 200,
  lastNavTs: 1_790_000_000,
  authority: "Auth111111111111111111111111111111111111111",
  shareMint: "Share11111111111111111111111111111111111111",
  shareSupply: "1470000",
  idleBalance: "1000000",
  unmanagedHoldings: [{ token: { mint: SOL, symbol: "SOL", decimals: 9 }, amount: "10000000" }],
  pendingDeposits: "5000000",
  pendingWithdrawalShares: "2000000",
  unclaimedManagerFeeShares: "500000",
  unclaimedPlatformFeeShares: "0",
  epochOutflow: "0",
  highWaterMark: "1020000000",
  navEpoch: "124",
  minDeposit: "10000000",
  minWithdrawalShares: "1000000",
  depositPaused: false,
  withdrawalPaused: true,
  pendingPerformanceFeeBps: 1000,
  pendingManagementFeeBps: 200,
  feeEffectiveTs: 0,
  openStrategyCount: 3,
  protocol: { status: "normal", maxEpochOutflowBps: 2000, maxSlippageBps: 300 },
};

export const navHistory: NavHistoryPoint[] = [
  { epoch: 123, ts: 1_790_006_400, totalAssets: "1400000", navPerShare: "1000000000", highWaterMark: "1000000000", overridden: false },
  { epoch: 124, ts: 1_790_020_800, totalAssets: "1500000", navPerShare: "1020000000", highWaterMark: "1020000000", overridden: true },
];

export const requestQueue: RequestQueue = {
  deposits: [{ owner: "Owner11111111111111111111111111111111111111", epoch: "124", createdTs: 1_790_021_000, state: "pending", cancellable: true, amount: "5000000" }],
  withdrawals: [{ owner: "Owner22222222222222222222222222222222222222", epoch: "123", createdTs: 1_790_010_000, state: "resolvable", cancellable: false, shares: "2000000" }],
};

export const strategyHistory: StrategyHistoryItem[] = [
  {
    strategy: "Closed1111111111111111111111111111111111111",
    id: 4,
    type: "dlmm",
    protocolAccount: null,
    openedTs: 1_790_000_000,
    closedTs: 1_790_020_800,
    openSignature: null,
    closeSignature: "5igCLoseSig1111111111111111111111111111111111111111111111111111111111111111111111111",
    exact: false,
    tokens: [
      { mint: USDC, symbol: "USDC", decimals: 6, contributed: "3000000", returned: "2500000", feesGross: "0", feesTreasury: "0", feesRetained: "0", realizedPnl: "-500000" },
      { mint: SOL, symbol: "SOL", decimals: 9, contributed: "0", returned: "10000000", feesGross: "0", feesTreasury: "0", feesRetained: "0", realizedPnl: "10000000" },
    ],
  },
];

const phoenixMarkets: PhoenixManager["markets"] = [
  { symbol: "SOL", name: "SOL-PERP", category: "major", maxLeverage: 20, markPrice: "150.25", tickSize: 0.01, baseLotsDecimals: 3, takerFee: 0.00035, makerFee: 0 },
  { symbol: "BTC", name: "BTC-PERP", category: "major", maxLeverage: 20, markPrice: "0", tickSize: 1, baseLotsDecimals: 4, takerFee: 0.00035, makerFee: 0 },
];

export const phoenixReady: PhoenixManager = {
  status: "ready",
  usdcVault: true,
  traderAccount: "Trader1111111111111111111111111111111111111",
  markets: phoenixMarkets,
  openOrders: [
    { symbol: "SOL", side: "long", price: "140", size: "0.5", priceInTicks: "14000", orderSequenceNumber: "9", reduceOnly: false },
    { symbol: "SOL", side: "short", price: "170", size: "0.25", priceInTicks: "17000", orderSequenceNumber: "10", reduceOnly: true },
  ],
  withdrawable: "4000000",
  account: {
    collateral: "5000000",
    equity: "5250000",
    initialMargin: "1000000",
    maintenanceMargin: "500000",
    withdrawable: "4000000",
    riskState: "healthy",
    liquidationPrices: { SOL: "98.5" },
  },
};

export const phoenixNone: PhoenixManager = { ...phoenixReady, status: "none", openOrders: null, withdrawable: null, account: null };
export const phoenixRegistered: PhoenixManager = { ...phoenixNone, status: "registered" };
