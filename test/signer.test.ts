import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { inspectTransaction, loadKeypair, signTransaction } from "../src/signer";

const PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
const manager = Keypair.generate();
const blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const vaultIx = (extraSigner?: PublicKey) =>
  new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: extraSigner ? [{ pubkey: extraSigner, isSigner: true, isWritable: true }] : [],
    data: Buffer.from([1]),
  });

function build(instructions: TransactionInstruction[], payer = manager.publicKey, preSign: Keypair[] = []): string {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (preSign.length > 0) tx.sign(preSign);
  return Buffer.from(tx.serialize()).toString("base64");
}

const policy = { manager: manager.publicKey, programId: PROGRAM_ID };

describe("inspectTransaction", () => {
  it("accepts a builder-shaped transaction and signs it", () => {
    const base64 = build([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      vaultIx(),
    ]);
    const tx = inspectTransaction(base64, policy);
    const signed = VersionedTransaction.deserialize(Buffer.from(signTransaction(tx, manager), "base64"));
    expect(signed.signatures[0]?.some((b) => b !== 0)).toBe(true);
  });

  it("keeps a builder-added position signature when the manager signs", () => {
    const position = Keypair.generate();
    const base64 = build([vaultIx(position.publicKey)], manager.publicKey);
    const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
    tx.sign([position]);
    const presigned = Buffer.from(tx.serialize()).toString("base64");
    const signed = VersionedTransaction.deserialize(Buffer.from(signTransaction(inspectTransaction(presigned, policy), manager), "base64"));
    expect(signed.signatures.every((sig) => sig.some((b) => b !== 0))).toBe(true);
  });

  it("refuses a transfer out of the manager wallet", () => {
    const base64 = build([SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }), vaultIx()]);
    expect(() => inspectTransaction(base64, policy)).toThrow(/Unexpected program 11111111111111111111111111111111/);
  });

  it("refuses a transaction paid by another wallet", () => {
    expect(() => inspectTransaction(build([vaultIx()], Keypair.generate().publicKey), policy)).toThrow(/Fee payer .* is not the bot's manager key/);
  });

  it("refuses when another required signature is missing", () => {
    expect(() => inspectTransaction(build([vaultIx(Keypair.generate().publicKey)]), policy)).toThrow(/also needs a signature/);
  });

  it("refuses a priority fee above the cap", () => {
    const base64 = build([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_001 }), vaultIx()]);
    expect(() => inspectTransaction(base64, policy)).toThrow(/above the bot's cap/);
  });

  it("refuses bytes that are not a transaction", () => {
    expect(() => inspectTransaction("bm90IGEgdHg=", policy)).toThrow(/Not a serialized Solana transaction/);
  });
});

describe("loadKeypair", () => {
  const dir = mkdtempSync(join(tmpdir(), "hv-bot-"));

  it("loads a Solana CLI keypair file", () => {
    const keypair = Keypair.generate();
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
    expect(loadKeypair(path).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects malformed files without echoing their contents", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify([1, 2, 3, "secret-ish"]));
    expect(() => loadKeypair(path)).toThrow("MANAGER_KEYPAIR_PATH: file is not a 64-byte Solana keypair array");
    expect(() => loadKeypair(join(dir, "missing.json"))).toThrow(/cannot read/);
  });
});
