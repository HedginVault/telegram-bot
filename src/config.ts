import { z } from "zod";

/** The Hedge Vault program at hedgin.xyz/idl/hedge_vault.json. */
const DEFAULT_PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ApiEnvSchema = z.object({
  HEDGE_API_BASE_URL: z.string().url().default("https://hedgin.xyz"),
  HEDGE_API_KEY: z.string().regex(/^hv1_[a-zA-Z0-9_-]+$/, "must look like hv1_<id>_<secret>"),
});

const BotEnvSchema = ApiEnvSchema.extend({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const ids = value.split(",").map((part) => part.trim());
      if (!ids.every((id) => /^\d+$/.test(id))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be comma-separated numeric Telegram user IDs" });
        return z.NEVER;
      }
      return new Set(ids.map(Number));
    }),
  MANAGER_KEYPAIR_PATH: z.string().min(1).optional(),
  HEDGE_PROGRAM_ID: z.string().regex(BASE58_KEY, "must be a base58 program id").default(DEFAULT_PROGRAM_ID),
});

export interface ApiConfig {
  apiBaseUrl: string;
  apiKey: string;
}

export interface Config extends ApiConfig {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<number>;
  /** Unset means read-only: no command can sign. */
  managerKeypairPath: string | undefined;
  programId: string;
}

function parse<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only; values may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

function apiConfig(data: z.infer<typeof ApiEnvSchema>): ApiConfig {
  return {
    // Accept both the site origin and the docs' "Base URL" (origin + /api/external/v1).
    apiBaseUrl: data.HEDGE_API_BASE_URL.replace(/\/+$/, "").replace(/\/api\/external\/v1$/, ""),
    apiKey: data.HEDGE_API_KEY,
  };
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return apiConfig(parse(ApiEnvSchema, env));
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const data = parse(BotEnvSchema, env);
  return {
    ...apiConfig(data),
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    allowedUserIds: data.ALLOWED_TELEGRAM_USER_IDS,
    managerKeypairPath: data.MANAGER_KEYPAIR_PATH,
    programId: data.HEDGE_PROGRAM_ID,
  };
}
