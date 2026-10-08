import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { parseSecretKey, writeKeyFile } from "../src/import-key";

const keypair = Keypair.generate();

describe("parseSecretKey", () => {
  it("reads a base58 wallet export with surrounding whitespace", () => {
    expect(parseSecretKey(`  ${bs58.encode(keypair.secretKey)}\n`).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("reads a Solana CLI JSON array", () => {
    expect(parseSecretKey(JSON.stringify(Array.from(keypair.secretKey))).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects a key whose public half does not match", () => {
    const tampered = Uint8Array.from(keypair.secretKey);
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(() => parseSecretKey(bs58.encode(tampered))).toThrow("Secret key is inconsistent: its public half does not match");
  });

  it("rejects wrong lengths and junk without echoing the input", () => {
    expect(() => parseSecretKey(bs58.encode(keypair.publicKey.toBytes()))).toThrow("Expected a 64-byte secret key, got 32 bytes");
    const junk = "not-a-key-0OIl";
    expect(() => parseSecretKey(junk)).toThrow("Input is neither a base58 private key nor a JSON byte array");
    expect(() => parseSecretKey(junk)).not.toThrow(new RegExp(junk));
  });
});

describe("writeKeyFile", () => {
  const repo = mkdtempSync(join(tmpdir(), "hv-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "hv-keys-"));

  it("writes an owner-only JSON keypair the bot can load", () => {
    const path = writeKeyFile(keypair, join(outside, "manager.json"), repo);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(Array.from(keypair.secretKey));
  });

  it("never overwrites an existing file", () => {
    const path = join(outside, "existing.json");
    writeKeyFile(keypair, path, repo);
    expect(() => writeKeyFile(Keypair.generate(), path, repo)).toThrow(/already exists; not overwriting it/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(Array.from(keypair.secretKey));
  });

  it("refuses a path inside the repository that git does not ignore", () => {
    expect(() => writeKeyFile(keypair, join(repo, "manager.json"), repo, () => false)).toThrow(/git does not ignore it/);
  });

  it("writes inside the repository when git ignores the path", () => {
    mkdirSync(join(repo, "keys"));
    const path = writeKeyFile(keypair, join(repo, "keys", "manager.json"), repo, () => true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
