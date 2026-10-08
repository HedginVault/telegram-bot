import type { ActionRequest } from "@hedginvault/sdk";
import type { TokenRef } from "./screens";

export const REMOVE_BPS = [2500, 5000, 10_000] as const;
export type RemoveBps = (typeof REMOVE_BPS)[number];
// Zap-out chains remove, claim, and a swap back to the deposit token, so it gets more room than a swap.
export const ZAP_OUT_SLIPPAGE_BPS = 100;
// Bins the active price may move between building and landing before the add is rejected.
export const MAX_ACTIVE_BIN_SLIPPAGE = 10;

/** Liquidity amounts for one side-or-both deposit, in base units. */
export interface LiquidityAmounts {
  amountX: string;
  amountY: string;
  /** What the user sees, e.g. "1.5 USDC". */
  display: { amountBaseUnits: string; token: TokenRef };
}

/** A fund-moving operation the user has picked but not yet confirmed. */
export type PendingAction =
  | { kind: "swap"; vault: string; input: TokenRef; output: TokenRef; amountBaseUnits: string; slippageBps: number }
  | { kind: "dlmmClaim"; vault: string; position: string; pairLabel: string }
  | { kind: "dlmmRemove"; vault: string; position: string; pairLabel: string; bps: RemoveBps }
  | { kind: "dlmmZapOut"; vault: string; position: string; pairLabel: string; depositSymbol: string }
  | { kind: "dlmmAdd"; vault: string; position: string; pairLabel: string; amounts: LiquidityAmounts }
  | {
      kind: "dlmmOpen";
      vault: string;
      lbPair: string;
      pairLabel: string;
      lowerBinId: number;
      /** Exclusive. */
      upperBinId: number;
      /** Display only: token Y per token X at each end of the range. */
      priceRange: { low: string; high: string };
      amounts: LiquidityAmounts;
    }
  | { kind: "closeStrategy"; vault: string; strategy: string; label: string };

export function toActionRequest(action: PendingAction): ActionRequest {
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
    case "dlmmRemove":
      return { action: "dlmm/remove", vault: action.vault, position: action.position, bpsToRemove: action.bps };
    case "dlmmZapOut":
      return { action: "dlmm/zap-out", vault: action.vault, position: action.position, slippageBps: ZAP_OUT_SLIPPAGE_BPS };
    case "closeStrategy":
      return { action: "strategy/close", vault: action.vault, strategy: action.strategy };
    case "dlmmAdd":
      return {
        action: "dlmm/add",
        vault: action.vault,
        position: action.position,
        amountX: action.amounts.amountX,
        amountY: action.amounts.amountY,
        shape: "spot",
        maxActiveBinSlippage: MAX_ACTIVE_BIN_SLIPPAGE,
      };
    case "dlmmOpen":
      return {
        action: "dlmm/open",
        vault: action.vault,
        lbPair: action.lbPair,
        lowerBinId: action.lowerBinId,
        upperBinId: action.upperBinId,
        amountX: action.amounts.amountX,
        amountY: action.amounts.amountY,
        shape: "spot",
        maxActiveBinSlippage: MAX_ACTIVE_BIN_SLIPPAGE,
      };
  }
}
