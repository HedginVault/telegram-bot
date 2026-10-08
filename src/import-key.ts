import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const USAGE = "Usage: pbpaste | yarn -s import-key <output.json>   (path outside this repository)";

/**
 * Accepts a wallet export (base58, as Phantom/Solflare show it) or a Solana CLI JSON array.
 * Errors never echo the input.
 */
export function parseSecretKey(text: string): Keypair {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  try {
    bytes = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
  } catch {
    throw new Error("Input is neither a base58 private key nor a JSON byte array");
  }
  if (bytes.length !== 64) throw new Error(`Expected a 64-byte secret key, got ${bytes.length} bytes`);
  try {
    // Validation checks that the public half matches the private half.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("Secret key is inconsistent: its public half does not match");
  }
}

/** Writes owner-only, never overwrites, and refuses paths inside `repoRoot` so the key cannot be committed. */
export function writeKeyFile(keypair: Keypair, outputPath: string, repoRoot: string): string {
  const target = resolve(outputPath);
  const inside = relative(resolve(repoRoot), target);
  if (!inside.startsWith("..") && !inside.startsWith("/")) {
    throw new Error("Refusing to write a keypair inside this repository; choose a path such as ~/keys/manager.json");
  }
  try {
    writeFileSync(target, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "EEXIST" ? `${target} already exists; not overwriting it` : `Cannot write ${target} (${code ?? "unknown error"})`);
  }
  return target;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output) throw new Error(USAGE);
  // Typing a key into the terminal would echo it and may land in scrollback.
  if (process.stdin.isTTY) throw new Error(`Pipe the key in instead of typing it.\n${USAGE}`);
  const keypair = parseSecretKey(await readStdin());
  const path = writeKeyFile(keypair, output, resolve(__dirname, ".."));
  console.log(`Saved ${path} (owner read/write only)`);
  console.log(`Public key: ${keypair.publicKey.toBase58()}`);
  console.log("Check it matches the vault manager, then set MANAGER_KEYPAIR_PATH to this path.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "import-key failed");
    process.exitCode = 1;
  });
}
