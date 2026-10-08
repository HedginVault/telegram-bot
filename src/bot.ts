import { Telegraf } from "telegraf";
import { ApiError, type HedgeApi } from "./api";
import { formatBaseUnits, shortAddress } from "./format";

const HELP_TEXT = [
  "Hedge Vault manager bot",
  "",
  "/vaults - list the vaults this API key can manage",
  "/help - show this message",
].join("\n");

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `API error ${error.status} (${error.code}): ${error.message}`;
  if (error instanceof Error && error.name === "TimeoutError") return "The Hedge Vault API did not answer in time. Try again.";
  return "Something went wrong. Check the bot logs.";
}

export function createBot(options: { token: string; allowedUserIds: ReadonlySet<number>; api: HedgeApi }): Telegraf {
  const bot = new Telegraf(options.token);

  // Unknown users get no reply, so the bot does not confirm it exists.
  bot.use((ctx, next) => (ctx.from && options.allowedUserIds.has(ctx.from.id) ? next() : undefined));

  bot.start((ctx) => ctx.reply(HELP_TEXT));
  bot.help((ctx) => ctx.reply(HELP_TEXT));

  bot.command("vaults", async (ctx) => {
    const vaults = await options.api.listVaults();
    if (vaults.length === 0) {
      await ctx.reply("This API key has no vaults in scope.");
      return;
    }
    const lines = vaults.map(
      (vault) =>
        `${vault.name} (${vault.status})\n  ${shortAddress(vault.address)}\n  TVL ${formatBaseUnits(vault.totalAssets, vault.depositDecimals)} ${vault.depositSymbol}`,
    );
    await ctx.reply(lines.join("\n\n"));
  });

  bot.catch(async (error, ctx) => {
    console.error("[telegram-bot] update failed", { updateId: ctx.update.update_id, error: describeError(error) });
    await ctx.reply(describeError(error)).catch(() => undefined);
  });

  return bot;
}
