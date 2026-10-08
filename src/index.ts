import { createHedgeApi } from "./api";
import { createBot } from "./bot";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const api = createHedgeApi({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
const bot = createBot({ token: config.telegramBotToken, allowedUserIds: config.allowedUserIds, api });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

console.log(`[telegram-bot] starting, API ${config.apiBaseUrl}, ${config.allowedUserIds.size} allowed user(s)`);
bot.launch().catch((error: unknown) => {
  console.error("[telegram-bot] stopped", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
