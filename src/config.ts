import { z } from "zod";

/** The Hedge Vault program at hedgin.xyz/idl/hedge_vault.json. */
const DEFAULT_PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const BotEnvSchema = z.object({
  HEDGE_API_BASE_URL: z.string().url().default("https://hedgin.xyz"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") return undefined;
      const ids = value.split(",").map((part) => part.trim());
      if (!ids.every((id) => /^\d+$/.test(id))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be comma-separated numeric Telegram user IDs" });
        return z.NEVER;
      }
      return new Set(ids.map(Number));
    }),
  WALLET_STORE_PATH: z.string().min(1).default("data/wallets.json"),
  WALLET_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (openssl rand -hex 32)"),
  TELEGRAM_USERS_PATH: z.string().min(1).default("data/telegram-users.json"),
  KEY_DELIVERY_SECRET: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? undefined : value))
    .pipe(z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)").optional()),
  KEY_DELIVERY_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HEDGE_PROGRAM_ID: z.string().regex(BASE58_KEY, "must be a base58 program id").default(DEFAULT_PROGRAM_ID),
});

export interface Config {
  apiBaseUrl: string;
  telegramBotToken: string;
  /** Unset means the bot is public. */
  allowedUserIds: ReadonlySet<number> | undefined;
  walletStorePath: string;
  walletEncryptionKey: Buffer;
  programId: string;
  usernameStorePath: string;
  /** Unset leaves the key-delivery endpoint off. */
  keyDeliverySecret: string | undefined;
  keyDeliveryPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = BotEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only; values may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  const data = parsed.data;
  return {
    // Accept both the site origin and the docs' "Base URL" (origin + /api/external/v1).
    apiBaseUrl: data.HEDGE_API_BASE_URL.replace(/\/+$/, "").replace(/\/api\/external\/v1$/, ""),
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    allowedUserIds: data.ALLOWED_TELEGRAM_USER_IDS,
    walletStorePath: data.WALLET_STORE_PATH,
    walletEncryptionKey: Buffer.from(data.WALLET_ENCRYPTION_KEY, "hex"),
    programId: data.HEDGE_PROGRAM_ID,
    usernameStorePath: data.TELEGRAM_USERS_PATH,
    keyDeliverySecret: data.KEY_DELIVERY_SECRET,
    keyDeliveryPort: data.KEY_DELIVERY_PORT,
  };
}
