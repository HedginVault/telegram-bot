import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

export const MAX_WALLETS_PER_USER = 10;
export const API_KEY_PATTERN = /^hv1_[a-zA-Z0-9_-]{34,177}$/;

export type WalletOrigin = "imported" | "generated";

/** What screens may see: never a secret. */
export interface WalletSummary {
  id: string;
  publicKey: string;
  origin: WalletOrigin;
  hasApiKey: boolean;
}

/** A wallet mistake the user can fix by trying again. */
export class WalletError extends Error {}

/**
 * Accepts a wallet export (base58, as Phantom/Solflare show it) or a Solana CLI JSON array.
 * Errors never echo the input.
 */
export function parseSecretKey(text: string): Keypair {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  try {
    bytes = trimmed.startsWith("[") ? Uint8Array.from(z.array(z.number().int().min(0).max(255)).parse(JSON.parse(trimmed))) : bs58.decode(trimmed);
  } catch {
    throw new WalletError("That is neither a base58 private key nor a JSON byte array.");
  }
  if (bytes.length !== 64) throw new WalletError(`A private key is 64 bytes; that was ${bytes.length}.`);
  try {
    // Validation checks that the public half matches the private half.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new WalletError("That private key is inconsistent: its public half does not match.");
  }
}

const SealedSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const WalletRecordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  publicKey: z.string(),
  origin: z.enum(["imported", "generated"]),
  createdAt: z.string(),
  secretKey: SealedSchema,
  apiKey: SealedSchema.optional(),
});
const FileSchema = z.object({
  version: z.literal(1),
  users: z.record(
    z.string().regex(/^\d+$/),
    z.object({ active: z.string().nullable(), wallets: z.array(WalletRecordSchema) }),
  ),
});
type WalletRecord = z.infer<typeof WalletRecordSchema>;
type WalletFile = z.infer<typeof FileSchema>;

/**
 * AES-256-GCM, with the owner, wallet, and field as associated data: a sealed value copied to
 * another user's or wallet's slot fails to open.
 */
function seal(masterKey: Buffer, context: string, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open(masterKey: Buffer, context: string, sealed: string): Buffer {
  const bytes = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

const context = (userId: number, record: Pick<WalletRecord, "id" | "publicKey">, field: "secretKey" | "apiKey") =>
  `hedge-vault-bot:v1:${userId}:${record.id}:${record.publicKey}:${field}`;

const summary = (record: WalletRecord): WalletSummary => ({
  id: record.id,
  publicKey: record.publicKey,
  origin: record.origin,
  hasApiKey: record.apiKey !== undefined,
});

/**
 * Each Telegram user's wallets, private keys and API keys encrypted at rest with one master key.
 * `path` undefined keeps everything in memory (tests).
 * ponytail: one JSON file rewritten per change, for one bot process; move to Postgres or a KMS-backed store
 * if the bot runs replicas or users reach the thousands.
 */
export function createWalletStore(path: string | undefined, masterKey: Buffer) {
  if (masterKey.length !== 32) throw new Error("The wallet master key must be 32 bytes");
  const data: WalletFile = path ? load(path) : { version: 1, users: {} };

  function load(file: string): WalletFile {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: {} };
      throw new Error(`Cannot read the wallet store (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
    const parsed = FileSchema.parse(JSON.parse(text));
    // Fail at startup, not at the first trade, when the master key is wrong or a file was tampered with.
    for (const [userId, user] of Object.entries(parsed.users)) {
      for (const record of user.wallets) {
        let keypair: Keypair;
        try {
          keypair = Keypair.fromSecretKey(open(masterKey, context(Number(userId), record, "secretKey"), record.secretKey));
        } catch {
          throw new Error("The wallet store does not open with WALLET_ENCRYPTION_KEY");
        }
        if (keypair.publicKey.toBase58() !== record.publicKey) throw new Error("The wallet store has a key that does not match its address");
      }
    }
    return parsed;
  }

  function save(): void {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, path);
  }

  const userOf = (userId: number) => (data.users[String(userId)] ??= { active: null, wallets: [] });

  function recordOf(userId: number, walletId: string): WalletRecord {
    const record = data.users[String(userId)]?.wallets.find((w) => w.id === walletId);
    if (!record) throw new WalletError("That wallet is no longer on your list.");
    return record;
  }

  return {
    list: (userId: number): WalletSummary[] => (data.users[String(userId)]?.wallets ?? []).map(summary),

    active(userId: number): WalletSummary | undefined {
      const user = data.users[String(userId)];
      const record = user?.wallets.find((w) => w.id === user.active);
      return record && summary(record);
    },

    /** Adds and activates a wallet. A wallet already on the list is only activated. */
    add(userId: number, keypair: Keypair, origin: WalletOrigin): { wallet: WalletSummary; existed: boolean } {
      const user = userOf(userId);
      const publicKey = keypair.publicKey.toBase58();
      const existing = user.wallets.find((w) => w.publicKey === publicKey);
      if (existing) {
        user.active = existing.id;
        save();
        return { wallet: summary(existing), existed: true };
      }
      if (user.wallets.length >= MAX_WALLETS_PER_USER) {
        throw new WalletError(`You already have ${MAX_WALLETS_PER_USER} wallets. Remove one first.`);
      }
      const record: WalletRecord = { id: randomBytes(8).toString("base64url"), publicKey, origin, createdAt: new Date().toISOString(), secretKey: "" };
      record.secretKey = seal(masterKey, context(userId, record, "secretKey"), Buffer.from(keypair.secretKey));
      user.wallets.push(record);
      user.active = record.id;
      save();
      return { wallet: summary(record), existed: false };
    },

    use(userId: number, walletId: string): WalletSummary {
      const record = recordOf(userId, walletId);
      userOf(userId).active = record.id;
      save();
      return summary(record);
    },

    /** Deletes the bot's only copy of the key. */
    remove(userId: number, walletId: string): void {
      const record = recordOf(userId, walletId);
      const user = userOf(userId);
      user.wallets = user.wallets.filter((w) => w !== record);
      if (user.active === record.id) user.active = user.wallets[0]?.id ?? null;
      save();
    },

    setApiKey(userId: number, walletId: string, apiKey: string): void {
      if (!API_KEY_PATTERN.test(apiKey)) throw new WalletError("An API key looks like hv1_<id>_<secret>.");
      const record = recordOf(userId, walletId);
      record.apiKey = seal(masterKey, context(userId, record, "apiKey"), Buffer.from(apiKey));
      save();
    },

    keypair(userId: number, walletId: string): Keypair {
      const record = recordOf(userId, walletId);
      return Keypair.fromSecretKey(open(masterKey, context(userId, record, "secretKey"), record.secretKey));
    },

    apiKey(userId: number, walletId: string): string | undefined {
      const record = recordOf(userId, walletId);
      return record.apiKey === undefined ? undefined : open(masterKey, context(userId, record, "apiKey"), record.apiKey).toString("utf8");
    },
  };
}
export type WalletStore = ReturnType<typeof createWalletStore>;
