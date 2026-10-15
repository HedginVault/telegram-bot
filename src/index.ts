import { createHedgeClient } from "@hedginxyz/sdk";
import { apiKeyChecker, createBot } from "./bot";
import { loadConfig } from "./config";
import { startKeyDeliveryServer } from "./key-delivery";
import { createUsernameStore } from "./telegram-users";
import { createWalletStore } from "./wallets";

const config = loadConfig(process.env);
const wallets = createWalletStore(config.walletStorePath, config.walletEncryptionKey);
const usernames = createUsernameStore(config.usernameStorePath);
const clientFor = (apiKey: string) => createHedgeClient({ baseUrl: config.apiBaseUrl, apiKey, programId: config.programId });
const bot = createBot({ token: config.telegramBotToken, allowedUserIds: config.allowedUserIds, wallets, usernames, clientFor });

const delivery =
  config.keyDeliverySecret === undefined
    ? undefined
    : startKeyDeliveryServer(config.keyDeliveryPort, {
        secret: config.keyDeliverySecret,
        usernames,
        wallets,
        checkApiKey: apiKeyChecker(clientFor),
        sendHtml: async (chatId, html) => {
          await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        },
      });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    delivery?.close();
    bot.stop(signal);
  });
}

console.log(
  `[telegram-bot] starting, API ${config.apiBaseUrl}, ` +
    (config.allowedUserIds ? `${config.allowedUserIds.size} allowed user(s)` : "public (no ALLOWED_TELEGRAM_USER_IDS)") +
    (delivery ? `, key delivery on port ${config.keyDeliveryPort}` : ", key delivery off"),
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
