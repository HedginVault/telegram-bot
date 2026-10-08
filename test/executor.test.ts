import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type BuiltStep, type HedgeApi, type TransactionStatus } from "../src/api";
import { type Progress, execute, groupSteps } from "../src/executor";

const PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
const manager = Keypair.generate();
const policy = { manager: manager.publicKey, programId: PROGRAM_ID };
let blockhashSeed = 1;

function step(options: { sendConcurrently?: boolean; next?: BuiltStep["next"]; transfer?: boolean } = {}): BuiltStep {
  const blockhash = new PublicKey(new Uint8Array(32).fill(blockhashSeed++)).toBase58();
  const instructions = [
    options.transfer
      ? SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
      : new TransactionInstruction({ programId: new PublicKey(PROGRAM_ID), keys: [], data: Buffer.from([blockhashSeed]) }),
  ];
  const message = new TransactionMessage({ payerKey: manager.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  return {
    transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"),
    simulation: { unitsConsumed: 1000 },
    ticket: `ticket-${blockhashSeed}`,
    blockhash,
    ...(options.sendConcurrently ? { sendConcurrently: true } : {}),
    ...(options.next ? { next: options.next } : {}),
  };
}

const signatureOfSigned = (base64: string) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(base64, "base64")).signatures[0] ?? new Uint8Array());

/** A fake API that records calls in order and confirms each receipt after `pendingPolls` polls. */
function fakeApi(builds: BuiltStep[][], options: { pendingPolls?: number; status?: (signature: string) => TransactionStatus; send?: HedgeApi["send"] } = {}) {
  const log: string[] = [];
  const polls = new Map<string, number>();
  const api: HedgeApi = {
    listVaults: vi.fn(),
    getHoldings: vi.fn(),
    getStrategies: vi.fn(),
    getQuote: vi.fn(),
    build: vi.fn(async (action: string) => {
      log.push(`build ${action}`);
      const result = builds.shift();
      if (!result) throw new Error("no more builds");
      return result;
    }),
    send:
      options.send ??
      vi.fn(async (transaction: string, ticket: string) => {
        const signature = signatureOfSigned(transaction);
        log.push(`send ${ticket}`);
        return { signature, receipt: `receipt:${signature}`, status: "pending" as const };
      }),
    status: vi.fn(async (receipt: string) => {
      const signature = receipt.slice("receipt:".length);
      const count = (polls.get(signature) ?? 0) + 1;
      polls.set(signature, count);
      log.push(`status ${signature.slice(0, 4)}`);
      if (options.status) return options.status(signature);
      return count > (options.pendingPolls ?? 0) ? { status: "confirmed" as const } : { status: "pending" as const };
    }),
  };
  return { api, log };
}

const deps = (api: HedgeApi, clock = { t: 0 }) => ({
  api,
  manager,
  policy,
  sleep: async (ms: number) => {
    clock.t += ms;
  },
  now: () => clock.t,
});

describe("groupSteps", () => {
  it("groups consecutive concurrent steps behind barriers", () => {
    const s = (sendConcurrently?: boolean) => ({ sendConcurrently });
    const a = s(), b = s(true), c = s(true), d = s(), e = s(true);
    expect(groupSteps([a, b, c, d, e])).toEqual([[a], [b, c], [d], [e]]);
  });
});

describe("execute", () => {
  it("builds, signs, sends, and polls one step to confirmation", async () => {
    const built = step();
    const { api, log } = fakeApi([[built]], { pendingPolls: 2 });
    const progress: Progress[] = [];
    const outcome = await execute({ action: "jupiter/swap", body: { vault: "V" } }, deps(api), (p) => {
      progress.push(p);
    });
    expect(outcome.kind).toBe("confirmed");
    expect(outcome.signatures).toHaveLength(1);
    expect(api.build).toHaveBeenCalledWith("jupiter/swap", { vault: "V" });
    expect(progress.map((p) => p.kind)).toEqual(["building", "sent", "confirmed"]);
    expect(log.filter((l) => l.startsWith("status"))).toHaveLength(3);
    const sent = vi.mocked(api.send).mock.calls[0]?.[0] ?? "";
    expect(VersionedTransaction.deserialize(Buffer.from(sent, "base64")).signatures[0]?.some((b) => b !== 0)).toBe(true);
  });

  it("builds the next step only after the current one confirms", async () => {
    const first = step({ next: { path: "dlmm/zap-out/swap", body: { vault: "V", sources: [] } } });
    const { api, log } = fakeApi([[first], [step()]]);
    const outcome = await execute({ action: "dlmm/zap-out", body: {} }, deps(api));
    expect(outcome).toMatchObject({ kind: "confirmed" });
    expect(outcome.signatures).toHaveLength(2);
    expect(api.build).toHaveBeenLastCalledWith("dlmm/zap-out/swap", { vault: "V", sources: [] });
    expect(log.indexOf("build dlmm/zap-out/swap")).toBeGreaterThan(log.findIndex((l) => l.startsWith("status")));
  });

  it("refuses an unsafe batch before sending any of it", async () => {
    const { api } = fakeApi([[step(), step({ transfer: true })]]);
    const outcome = await execute({ action: "jupiter/swap", body: {} }, deps(api));
    expect(outcome).toEqual({ kind: "refused", signatures: [], reason: "Unexpected program 11111111111111111111111111111111" });
    expect(api.send).not.toHaveBeenCalled();
  });

  it("reports an on-chain failure with its code", async () => {
    const { api } = fakeApi([[step()]], { status: () => ({ status: "failed", code: "SlippageExceeded", message: "Price moved" }) });
    const outcome = await execute({ action: "jupiter/swap", body: {} }, deps(api));
    expect(outcome).toMatchObject({ kind: "failed", code: "SlippageExceeded", message: "Price moved" });
  });

  it("reports a build rejection without sending", async () => {
    const { api } = fakeApi([]);
    vi.mocked(api.build).mockRejectedValueOnce(new ApiError(503, "ApiUnavailable", "Service temporarily unavailable"));
    const outcome = await execute({ action: "jupiter/swap", body: {} }, deps(api));
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "ApiUnavailable", message: "Service temporarily unavailable" });
    expect(api.send).not.toHaveBeenCalled();
  });

  it("never rebuilds after an ambiguous send and hands back the local signature", async () => {
    const built = step();
    const send = vi.fn(async () => {
      throw new ApiError(503, "RpcUnavailable", "Service temporarily unavailable");
    });
    const { api } = fakeApi([[built]], { send });
    const outcome = await execute({ action: "jupiter/swap", body: {} }, deps(api));
    expect(outcome.kind).toBe("unresolved");
    expect(outcome.signatures).toHaveLength(1);
    expect(outcome).toMatchObject({ pending: outcome.signatures });
    expect(api.build).toHaveBeenCalledTimes(1);
  });

  it("sends a concurrent group together, then polls, then moves to the next barrier", async () => {
    const { api, log } = fakeApi([[step(), step({ sendConcurrently: true }), step({ sendConcurrently: true }), step()]]);
    const outcome = await execute({ action: "dlmm/remove", body: {} }, deps(api));
    expect(outcome.signatures).toHaveLength(4);
    const kinds = log.map((l) => l.split(" ")[0]);
    expect(kinds).toEqual(["build", "send", "status", "send", "send", "status", "status", "send", "status"]);
  });

  it("settles already-sent steps before reporting a mid-batch rejection", async () => {
    let sends = 0;
    const send = vi.fn(async (transaction: string) => {
      if (++sends === 2) throw new ApiError(403, "InvalidTicket", "Invalid or expired ticket");
      const signature = signatureOfSigned(transaction);
      return { signature, receipt: `receipt:${signature}`, status: "pending" as const };
    });
    const { api, log } = fakeApi([[step({ sendConcurrently: true }), step({ sendConcurrently: true })]], { send });
    const outcome = await execute({ action: "dlmm/remove", body: {} }, deps(api));
    expect(outcome).toMatchObject({ kind: "failed", code: "InvalidTicket" });
    expect(outcome.signatures).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("status"))).toHaveLength(1);
  });

  it("gives up polling at the deadline as unresolved, not failed", async () => {
    const { api } = fakeApi([[step()]], { status: () => ({ status: "pending" }) });
    const clock = { t: 0 };
    const outcome = await execute({ action: "jupiter/swap", body: {} }, deps(api, clock));
    expect(outcome.kind).toBe("unresolved");
    expect(clock.t).toBeGreaterThanOrEqual(120_000);
  });
});
