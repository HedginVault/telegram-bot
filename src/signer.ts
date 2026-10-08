import { readFileSync } from "node:fs";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Programs the app's V1 builders call as top-level instructions. Token movement happens by CPI
 * inside the Hedge Vault program, so nothing here can transfer funds out of the manager wallet;
 * the manager only pays rent (ATA, DLMM bin arrays) and the capped priority fee.
 */
const BUILDER_PROGRAMS = [
  COMPUTE_BUDGET_PROGRAM,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account: create-idempotent
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM: initializeBinArray
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter: setTokenLedger in zap-out
];

/** The app caps priority fees at 10,000 microLamports per CU; allow headroom, not an open checkbook. */
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 100_000n;

/** A server-built transaction the bot refuses to sign. */
export class UnsafeTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTransactionError";
  }
}

export interface SigningPolicy {
  manager: PublicKey;
  programId: string;
}

/** Decodes a builder transaction and checks it against the policy before anything signs it. */
export function inspectTransaction(base64: string, policy: SigningPolicy): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    throw new UnsafeTransactionError("Not a serialized Solana transaction");
  }
  if (tx.version !== 0) throw new UnsafeTransactionError("Expected a v0 transaction");

  const { staticAccountKeys, header, compiledInstructions } = tx.message;
  const payer = staticAccountKeys[0];
  if (!payer?.equals(policy.manager)) {
    throw new UnsafeTransactionError(`Fee payer ${payer?.toBase58() ?? "missing"} is not the bot's manager key`);
  }
  for (let index = 1; index < header.numRequiredSignatures; index++) {
    if (tx.signatures[index]?.every((byte) => byte === 0) !== false) {
      throw new UnsafeTransactionError(`Transaction also needs a signature from ${staticAccountKeys[index]?.toBase58() ?? "an unknown key"}`);
    }
  }

  const allowed = new Set([policy.programId, ...BUILDER_PROGRAMS]);
  for (const instruction of compiledInstructions) {
    // v0 requires invoked programs to be static keys; an index past them would be malformed.
    const program = staticAccountKeys[instruction.programIdIndex]?.toBase58();
    if (!program || !allowed.has(program)) throw new UnsafeTransactionError(`Unexpected program ${program ?? "outside static keys"}`);
    if (program === COMPUTE_BUDGET_PROGRAM && instruction.data[0] === SET_COMPUTE_UNIT_PRICE) {
      const price = Buffer.from(instruction.data).readBigUInt64LE(1);
      if (price > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
        throw new UnsafeTransactionError(`Priority fee ${price} microLamports/CU is above the bot's cap`);
      }
    }
  }
  return tx;
}

/** Adds the manager signature; signatures the builder already added (e.g. a new DLMM position) stay. */
export function signTransaction(tx: VersionedTransaction, manager: Keypair): string {
  tx.sign([manager]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Reads a Solana CLI keypair file (JSON array of 64 bytes). Errors never include the file contents. */
export function loadKeypair(path: string): Keypair {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`MANAGER_KEYPAIR_PATH: cannot read a JSON keypair file at ${path}`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("MANAGER_KEYPAIR_PATH: file is not a 64-byte Solana keypair array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}
