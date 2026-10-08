import type { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ApiError, type BuiltStep, type HedgeApi } from "./api";
import { type SigningPolicy, UnsafeTransactionError, inspectTransaction, signTransaction } from "./signer";

const POLL_INTERVAL_MS = 2_000;
// A blockhash lives ~60-90 s; past this the API reports `expired` or the outcome is truly unknown.
const CONFIRM_DEADLINE_MS = 120_000;
// `next` continuations (DLMM extend/zap-out) are short chains; a long one means something is looping.
const MAX_BUILDS = 12;

export interface BuildRequest {
  action: string;
  body: Record<string, unknown>;
}

export type Progress =
  | { kind: "building"; action: string }
  | { kind: "sent"; signature: string; status: "pending" | "unknown" }
  | { kind: "confirmed"; signature: string };

export type Outcome =
  | { kind: "confirmed"; signatures: string[] }
  /** Nothing in the failing build was sent. */
  | { kind: "refused"; signatures: string[]; reason: string }
  | { kind: "failed"; signatures: string[]; signature?: string; code: string; message: string }
  /** Sent, but neither confirmed nor failed in time. Do not resend; check the explorer. */
  | { kind: "unresolved"; signatures: string[]; pending: string[] };

export interface ExecutorDeps {
  api: HedgeApi;
  manager: Keypair;
  policy: SigningPolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Consecutive `sendConcurrently` steps go out together; any other step is a confirmation barrier. */
export function groupSteps<T extends { sendConcurrently?: boolean }>(steps: T[]): T[][] {
  const groups: T[][] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (step.sendConcurrently && last?.[0]?.sendConcurrently) last.push(step);
    else groups.push([step]);
  }
  return groups;
}

const signatureOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0] ?? new Uint8Array(64));

/**
 * Runs one bot action to a terminal outcome. Retries never rebuild: an ambiguous send is polled
 * by its receipt, because rebuilding could execute the action twice.
 */
export async function execute(request: BuildRequest, deps: ExecutorDeps, onProgress: (p: Progress) => void | Promise<void> = () => {}): Promise<Outcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const signatures: string[] = [];
  let next: BuildRequest | undefined = request;

  for (let builds = 0; next; builds++) {
    if (builds === MAX_BUILDS) return { kind: "failed", signatures, code: "TooManySteps", message: `Stopped after ${MAX_BUILDS} builds` };
    await onProgress({ kind: "building", action: next.action });
    let steps: BuiltStep[];
    let txs: VersionedTransaction[];
    try {
      steps = await deps.api.build(next.action, next.body);
      // Inspect the whole batch before sending any of it.
      txs = steps.map((step) => inspectTransaction(step.transaction, deps.policy));
    } catch (error) {
      if (error instanceof UnsafeTransactionError) return { kind: "refused", signatures, reason: error.message };
      if (error instanceof ApiError) return { kind: "failed", signatures, code: error.code, message: error.message };
      throw error;
    }

    for (const group of groupSteps(steps.map((step, i) => ({ step, tx: txs[i] as VersionedTransaction, sendConcurrently: step.sendConcurrently })))) {
      const receipts: { signature: string; receipt?: string }[] = [];
      let rejected: ApiError | undefined;
      for (const { step, tx } of group) {
        const signed = signTransaction(tx, deps.manager);
        const signature = signatureOf(tx);
        try {
          const sent = await deps.api.send(signed, step.ticket);
          signatures.push(sent.signature);
          receipts.push({ signature: sent.signature, receipt: sent.receipt });
          await onProgress({ kind: "sent", signature: sent.signature, status: sent.status });
        } catch (error) {
          if (error instanceof ApiError && error.status < 500) {
            rejected = error;
            break;
          }
          // A timeout or 5xx without a receipt may still have reached the network.
          signatures.push(signature);
          receipts.push({ signature });
          await onProgress({ kind: "sent", signature, status: "unknown" });
        }
      }
      // Steps sent before a rejection may still land, so settle them before reporting anything.
      const settled = await settle(receipts, deps.api, sleep, now);
      if (settled.kind !== "confirmed") return { ...settled, signatures };
      for (const { signature } of receipts) await onProgress({ kind: "confirmed", signature });
      if (rejected) return { kind: "failed", signatures, code: rejected.code, message: rejected.message };
    }
    const continuation = [...steps].reverse().find((step) => step.next)?.next;
    next = continuation && { action: continuation.path, body: continuation.body };
  }
  return { kind: "confirmed", signatures };
}

type Settled =
  | { kind: "confirmed" }
  | { kind: "failed"; signature: string; code: string; message: string }
  | { kind: "unresolved"; pending: string[] };

async function settle(
  receipts: { signature: string; receipt?: string }[],
  api: HedgeApi,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<Settled> {
  const deadline = now() + CONFIRM_DEADLINE_MS;
  const open = new Map(receipts.map((r) => [r.signature, r.receipt]));
  while (open.size > 0) {
    for (const [signature, receipt] of open) {
      if (!receipt) continue;
      const status = await api.status(receipt).catch(() => undefined);
      if (status?.status === "confirmed") open.delete(signature);
      else if (status?.status === "failed") return { kind: "failed", signature, code: status.code, message: status.message };
      else if (status?.status === "expired") return { kind: "failed", signature, code: "Expired", message: "Blockhash expired before the transaction landed" };
    }
    if (open.size === 0) break;
    if ([...open.values()].every((receipt) => !receipt) || now() >= deadline) return { kind: "unresolved", pending: [...open.keys()] };
    await sleep(POLL_INTERVAL_MS);
  }
  return { kind: "confirmed" };
}
