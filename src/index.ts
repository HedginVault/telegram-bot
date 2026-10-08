import { createHedgeClient } from "@hedginvault/sdk";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { createWalletStore } from "./wallets";

const config = loadConfig(process.env);
const wallets = createWalletStore(config.walletStorePath, config.walletEncryptionKey);
const bot = createBot({
  token: config.telegramBotToken,
  allowedUserIds: config.allowedUserIds,
  wallets,
  clientFor: (apiKey) => createHedgeClient({ baseUrl: config.apiBaseUrl, apiKey, programId: config.programId }),
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

console.log(
  `[telegram-bot] starting, API ${config.apiBaseUrl}, ` +
    (config.allowedUserIds ? `${config.allowedUserIds.size} allowed user(s)` : "public (no ALLOWED_TELEGRAM_USER_IDS)"),
);
// Fills Telegram's "/" menu so commands are tappable too.
void bot.telegram
  .setMyCommands([
    { command: "start", description: "Open the vault menu" },
    { command: "wallet", description: "Import, create, export, or switch wallets" },
    { command: "vaults", description: "List vaults" },
    { command: "help", description: "How to use this bot" },
    { command: "cancel", description: "Stop typing into a form" },
  ])
  .catch((error: unknown) => console.error("[telegram-bot] setMyCommands failed", error instanceof Error ? error.message : "unknown error"));

bot.launch().catch((error: unknown) => {
  console.error("[telegram-bot] stopped", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
