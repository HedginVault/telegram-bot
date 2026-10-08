import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { MAX_WALLETS_PER_USER, createWalletStore, parseSecretKey } from "../src/wallets";

const keypair = Keypair.generate();
const API_KEY = `hv1_partner_${"f".repeat(64)}`;
const tempStore = () => join(mkdtempSync(join(tmpdir(), "hv-wallets-")), "nested", "wallets.json");

describe("parseSecretKey", () => {
  it("reads a base58 wallet export with surrounding whitespace", () => {
    expect(parseSecretKey(`  ${bs58.encode(keypair.secretKey)}\n`).publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it("reads a Solana CLI JSON array", () => {
    expect(parseSecretKey(JSON.stringify(Array.from(keypair.secretKey))).publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it("rejects a key whose public half does not match", () => {
    const tampered = Uint8Array.from(keypair.secretKey);
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(() => parseSecretKey(bs58.encode(tampered))).toThrow("That private key is inconsistent: its public half does not match.");
  });

  it("rejects wrong lengths, out-of-range bytes, and junk without echoing the input", () => {
    expect(() => parseSecretKey(bs58.encode(keypair.publicKey.toBytes()))).toThrow("A private key is 64 bytes; that was 32.");
    expect(() => parseSecretKey(JSON.stringify([...Array(63).fill(1), 256]))).toThrow("That is neither a base58 private key nor a JSON byte array.");
    const junk = "not-a-key-0OIl";
    expect(() => parseSecretKey(junk)).toThrow("That is neither a base58 private key nor a JSON byte array.");
    expect(() => parseSecretKey(junk)).not.toThrow(new RegExp(junk));
  });
});

describe("wallet store", () => {
  it("persists encrypted wallets owner-only and reopens them with the same master key", () => {
    const path = tempStore();
    const masterKey = randomBytes(32);
    const store = createWalletStore(path, masterKey);
    const { wallet } = store.add(1, keypair, "imported");
    store.setApiKey(1, wallet.id, API_KEY);

    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(bs58.encode(keypair.secretKey));
    expect(text).not.toContain(API_KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reopened = createWalletStore(path, masterKey);
    expect(reopened.active(1)).toEqual({ id: wallet.id, publicKey: keypair.publicKey.toBase58(), origin: "imported", hasApiKey: true });
    expect(reopened.keypair(1, wallet.id).publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(reopened.apiKey(1, wallet.id)).toBe(API_KEY);
  });

  it("refuses to start with the wrong master key", () => {
    const path = tempStore();
    createWalletStore(path, randomBytes(32)).add(1, keypair, "imported");
    expect(() => createWalletStore(path, randomBytes(32))).toThrow("The wallet store does not open with WALLET_ENCRYPTION_KEY");
  });

  it("refuses a sealed key moved into another user's slot", () => {
    const path = tempStore();
    const masterKey = randomBytes(32);
    createWalletStore(path, masterKey).add(1, keypair, "imported");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.users["2"] = file.users["1"];
    delete file.users["1"];
    writeFileSync(path, JSON.stringify(file));
    expect(() => createWalletStore(path, masterKey)).toThrow("The wallet store does not open with WALLET_ENCRYPTION_KEY");
  });

  it("keeps each user's wallets to themselves", () => {
    const store = createWalletStore(undefined, randomBytes(32));
    const { wallet } = store.add(1, keypair, "imported");
    expect(store.list(2)).toEqual([]);
    expect(() => store.keypair(2, wallet.id)).toThrow("That wallet is no longer on your list.");
    expect(() => store.use(2, wallet.id)).toThrow("That wallet is no longer on your list.");
    expect(() => store.remove(2, wallet.id)).toThrow("That wallet is no longer on your list.");
  });

  it("activates instead of duplicating a re-imported wallet, and moves the active wallet on removal", () => {
    const store = createWalletStore(undefined, randomBytes(32));
    const first = store.add(1, keypair, "imported").wallet;
    const second = store.add(1, Keypair.generate(), "generated").wallet;
    expect(store.active(1)?.id).toBe(second.id);
    expect(store.add(1, keypair, "imported")).toEqual({ wallet: first, existed: true });
    expect(store.active(1)?.id).toBe(first.id);
    store.remove(1, first.id);
    expect(store.list(1).map((w) => w.id)).toEqual([second.id]);
    expect(store.active(1)?.id).toBe(second.id);
  });

  it(`caps each user at ${MAX_WALLETS_PER_USER} wallets`, () => {
    const store = createWalletStore(undefined, randomBytes(32));
    for (let i = 0; i < MAX_WALLETS_PER_USER; i++) store.add(1, Keypair.generate(), "generated");
    expect(() => store.add(1, Keypair.generate(), "generated")).toThrow(`You already have ${MAX_WALLETS_PER_USER} wallets. Remove one first.`);
  });
});
