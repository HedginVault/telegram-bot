import type { BuildAction } from "./api";
import type { BuildRequest } from "./executor";
import type { TokenRef } from "./screens";

export const REMOVE_BPS = [2500, 5000, 10_000] as const;
export type RemoveBps = (typeof REMOVE_BPS)[number];
// Zap-out chains remove, claim, and a swap back to the deposit token, so it gets more room than a swap.
export const ZAP_OUT_SLIPPAGE_BPS = 100;

/** A fund-moving operation the user has picked but not yet confirmed. */
export type PendingAction =
  | { kind: "swap"; vault: string; input: TokenRef; output: TokenRef; amountBaseUnits: string; slippageBps: number }
  | { kind: "dlmmClaim"; vault: string; position: string; pairLabel: string }
  | { kind: "dlmmRemove"; vault: string; position: string; pairLabel: string; bps: RemoveBps }
  | { kind: "dlmmZapOut"; vault: string; position: string; pairLabel: string; depositSymbol: string }
  | { kind: "closeStrategy"; vault: string; strategy: string; label: string };

function request(action: BuildAction, body: Record<string, unknown>): BuildRequest {
  return { action, body };
}

export function toBuildRequest(action: PendingAction): BuildRequest {
  switch (action.kind) {
    case "swap":
      return request("jupiter/swap", {
        vault: action.vault,
        sourceMint: action.input.mint,
        destinationMint: action.output.mint,
        amount: action.amountBaseUnits,
        slippageBps: action.slippageBps,
      });
    case "dlmmClaim":
      return request("dlmm/claim-fee", { vault: action.vault, position: action.position });
    case "dlmmRemove":
      return request("dlmm/remove", { vault: action.vault, position: action.position, bpsToRemove: action.bps });
    case "dlmmZapOut":
      return request("dlmm/zap-out", { vault: action.vault, position: action.position, slippageBps: ZAP_OUT_SLIPPAGE_BPS });
    case "closeStrategy":
      return request("strategy/close", { vault: action.vault, strategy: action.strategy });
  }
}
