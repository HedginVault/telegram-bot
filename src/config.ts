import { z } from "zod";

const EnvSchema = z.object({
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
  HEDGE_API_BASE_URL: z.string().url().default("https://hedgin.xyz"),
  HEDGE_API_KEY: z.string().regex(/^hv1_[a-zA-Z0-9_-]+$/, "must look like hv1_<id>_<secret>"),
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<number>;
  apiBaseUrl: string;
  apiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only; values may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    allowedUserIds: parsed.data.ALLOWED_TELEGRAM_USER_IDS,
    // Accept both the site origin and the docs' "Base URL" (origin + /api/external/v1).
    apiBaseUrl: parsed.data.HEDGE_API_BASE_URL.replace(/\/+$/, "").replace(/\/api\/external\/v1$/, ""),
    apiKey: parsed.data.HEDGE_API_KEY,
  };
}
