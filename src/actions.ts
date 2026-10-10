import type { ActionRequest, DlmmShape, ExecuteOptions, HedgeClient, Outcome, TransactionSigner } from "@hedginvault/sdk";
import type { TokenRef } from "./ui";

export const REMOVE_BPS = [2500, 5000, 10_000] as const;
export type RemoveBps = (typeof REMOVE_BPS)[number];
// Zap-out chains remove, claim, and a swap back to the deposit token, so it gets more room than a swap.
export const ZAP_OUT_SLIPPAGE_BPS = 100;
// Bins the active price may move between building and landing before an add or flip is rejected.
export const MAX_ACTIVE_BIN_SLIPPAGE = 10;

/** Both sides of a liquidity deposit, in base units, with the tokens for display. */
export interface Liquidity {
  tokenX: TokenRef;
  tokenY: TokenRef;
  amountX: string;
  amountY: string;
  shape: DlmmShape;
}

/** Position bins on one side of the price, both ends inclusive as the API takes them. */
export interface SideBins {
  side: "above" | "below";
  lowerBinId: number;
  upperBinId: number;
  /** Display only: prices of the first and last bin. */
  priceRange: { low: string; high: string };
}

/** Any inclusive bin range of a position, with what a remove there takes, for display. */
export interface RangeBins {
  /** What the manager picked, e.g. "top 25% of bins". */
  label: string;
  lowerBinId: number;
  upperBinId: number;
  priceRange: { low: string; high: string };
  tokenX: TokenRef;
  tokenY: TokenRef;
  /** Display only: summed per-bin amounts in these bins at the remove's share, each bin floored. */
  amountXBaseUnits: string;
  amountYBaseUnits: string;
}

/** One side's bins of a position and the token they hold, as the remove picker and flip use them. */
export interface SideLiquidity {
  bins: SideBins;
  token: TokenRef;
  activeBinId: number;
  amountBaseUnits: string;
  /** No per-bin data from the API: `amountBaseUnits` is the position's whole side, the active bin included. */
  amountIsSideTotal: boolean;
}

/** Fields of a `vault/update` besides the vault; only the ones given change. */
export type VaultChanges = Omit<Extract<ActionRequest, { action: "vault/update" }>, "action" | "vault">;
/** A Phoenix order as `phoenix/order` takes it, without the vault. */
export type PhoenixOrder = Omit<Extract<ActionRequest, { action: "phoenix/order" }>, "action" | "vault">;

/** A fund-moving operation the user has picked but not yet confirmed. */
export type PendingAction =
  | {
      kind: "swap";
      vault: string;
      input: TokenRef;
      output: TokenRef;
      amountBaseUnits: string;
      slippageBps: number;
      /** The non-deposit token is not Jupiter-verified (or unknown). */
      unverified: boolean;
    }
  | { kind: "dlmmClaim"; vault: string; position: string; pairLabel: string }
  /** Without `bins`, removes from every bin. */
  | { kind: "dlmmRemove"; vault: string; position: string; pairLabel: string; bps: RemoveBps; bins?: SideBins | RangeBins }
  | {
      kind: "dlmmFlip";
      vault: string;
      position: string;
      pairLabel: string;
      token: TokenRef;
      bins: SideBins;
      /** The active bin the bot read; the API rejects the flip if the price moved further than the slippage. */
      activeBinId: number;
      /** Display only: the token in those bins, or the position's whole side when the API sent no per-bin data. */
      amountBaseUnits: string;
      amountIsSideTotal: boolean;
    }
  | { kind: "dlmmZapOut"; vault: string; position: string; pairLabel: string; depositSymbol: string }
  | { kind: "dlmmAdd"; vault: string; position: string; pairLabel: string; liquidity: Liquidity }
  | {
      kind: "dlmmOpen";
      vault: string;
      lbPair: string;
      pairLabel: string;
      lowerBinId: number;
      /** Exclusive. */
      upperBinId: number;
      /** Display only: actual edge prices of the bin range. */
      priceRange: { low: string; high: string };
      liquidity: Liquidity;
    }
  | {
      kind: "dlmmInit";
      vault: string;
      lbPair: string;
      pairLabel: string;
      lowerBinId: number;
      /** Exclusive. */
      upperBinId: number;
      priceRange: { low: string; high: string };
    }
  | { kind: "dlmmClose"; vault: string; position: string; pairLabel: string }
  | { kind: "closeStrategy"; vault: string; strategy: string; label: string }
  | { kind: "jupiterInit"; vault: string; token: TokenRef; verified: boolean | null }
  | { kind: "phoenixInit"; vault: string }
  /** Not a builder: runs `onboardPhoenix`, which Phoenix co-signs. */
  | { kind: "phoenixOnboard"; vault: string }
  | { kind: "phoenixDeposit"; vault: string; amountBaseUnits: string }
  | { kind: "phoenixWithdraw"; vault: string; amountBaseUnits: string }
  | { kind: "phoenixOrder"; vault: string; order: PhoenixOrder }
  | { kind: "phoenixCancel"; vault: string; symbol: string }
  | { kind: "phoenixSweep"; vault: string }
  /** The only action without a vault: it creates one. */
  | {
      kind: "vaultCreate";
      name: string;
      deposit: TokenRef;
      performanceFeeBps: number;
      managementFeeBps: number;
      depositCap: string;
      minDeposit: string;
      /** Share base units; shares have the deposit token's decimals. */
      minWithdrawalShares: string;
    }
  /** `deposit` is display only: limits are in its units. */
  | { kind: "vaultUpdate"; vault: string; deposit: TokenRef; changes: VaultChanges }
  | { kind: "vaultClaimFee"; vault: string }
  | { kind: "vaultClose"; vault: string };

export const actionVault = (action: PendingAction): string | undefined => ("vault" in action ? action.vault : undefined);

/** The API key action this needs besides `send`; named in the hint when a key lacks it. */
export const actionScope = (action: PendingAction): string => (action.kind === "phoenixOnboard" ? "phoenix/onboard" : toActionRequest(action).action);

/** Runs a confirmed action. Phoenix onboarding has its own SDK path; everything else is a builder. */
export function executeAction(api: HedgeClient, action: PendingAction, signer: TransactionSigner, options: ExecuteOptions): Promise<Outcome> {
  return action.kind === "phoenixOnboard" ? api.onboardPhoenix(action.vault, signer, options) : api.execute(toActionRequest(action), signer, options);
}

export function toActionRequest(action: Exclude<PendingAction, { kind: "phoenixOnboard" }>): ActionRequest {
  switch (action.kind) {
    case "swap":
      return {
        action: "jupiter/swap",
        vault: action.vault,
        sourceMint: action.input.mint,
        destinationMint: action.output.mint,
        amount: action.amountBaseUnits,
        slippageBps: action.slippageBps,
      };
    case "dlmmClaim":
      return { action: "dlmm/claim-fee", vault: action.vault, position: action.position };
    case "dlmmRemove": {
      const remove = { action: "dlmm/remove", vault: action.vault, position: action.position, bpsToRemove: action.bps } as const;
      return action.bins ? { ...remove, lowerBinId: action.bins.lowerBinId, upperBinId: action.bins.upperBinId } : remove;
    }
    case "dlmmFlip":
      return {
        action: "dlmm/flip",
        vault: action.vault,
        position: action.position,
        lowerBinId: action.bins.lowerBinId,
        upperBinId: action.bins.upperBinId,
        activeBinId: action.activeBinId,
        maxActiveBinSlippage: MAX_ACTIVE_BIN_SLIPPAGE,
      };
    case "dlmmZapOut":
      return { action: "dlmm/zap-out", vault: action.vault, position: action.position, slippageBps: ZAP_OUT_SLIPPAGE_BPS };
    case "closeStrategy":
      return { action: "strategy/close", vault: action.vault, strategy: action.strategy };
    case "dlmmAdd":
      return {
        action: "dlmm/add",
        vault: action.vault,
        position: action.position,
        amountX: action.liquidity.amountX,
        amountY: action.liquidity.amountY,
        shape: action.liquidity.shape,
        maxActiveBinSlippage: MAX_ACTIVE_BIN_SLIPPAGE,
      };
    case "dlmmOpen":
      return {
        action: "dlmm/open",
        vault: action.vault,
        lbPair: action.lbPair,
        lowerBinId: action.lowerBinId,
        upperBinId: action.upperBinId,
        amountX: action.liquidity.amountX,
        amountY: action.liquidity.amountY,
        shape: action.liquidity.shape,
        maxActiveBinSlippage: MAX_ACTIVE_BIN_SLIPPAGE,
      };
    case "dlmmInit":
      return { action: "dlmm/initialize", vault: action.vault, lbPair: action.lbPair, lowerBinId: action.lowerBinId, upperBinId: action.upperBinId };
    case "dlmmClose":
      return { action: "dlmm/close", vault: action.vault, position: action.position };
    case "jupiterInit":
      return { action: "jupiter/initialize", vault: action.vault, targetMint: action.token.mint };
    case "phoenixInit":
      return { action: "phoenix/initialize", vault: action.vault };
    case "phoenixDeposit":
      return { action: "phoenix/deposit", vault: action.vault, amount: action.amountBaseUnits };
    case "phoenixWithdraw":
      return { action: "phoenix/withdraw", vault: action.vault, amount: action.amountBaseUnits };
    case "phoenixOrder":
      return { action: "phoenix/order", vault: action.vault, ...action.order };
    case "phoenixCancel":
      return { action: "phoenix/cancel", vault: action.vault, symbol: action.symbol, orders: "all" };
    case "phoenixSweep":
      return { action: "phoenix/sweep", vault: action.vault };
    case "vaultCreate":
      return {
        action: "vault/initialize",
        name: action.name,
        depositMint: action.deposit.mint,
        performanceFeeBps: action.performanceFeeBps,
        managementFeeBps: action.managementFeeBps,
        depositCap: action.depositCap,
        minDeposit: action.minDeposit,
        minWithdrawalShares: action.minWithdrawalShares,
      };
    case "vaultUpdate":
      return { action: "vault/update", vault: action.vault, ...action.changes };
    case "vaultClaimFee":
      return { action: "vault/claim-fee", vault: action.vault };
    case "vaultClose":
      return { action: "vault/close", vault: action.vault };
  }
}
