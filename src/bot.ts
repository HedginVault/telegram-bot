import { type Context, Telegraf } from "telegraf";
import { ApiError, type HedgeApi, type VaultSummary } from "./api";
import {
  HELP_MESSAGE,
  errorMessage,
  fitMessage,
  holdingsMessage,
  quoteMessage,
  strategiesMessage,
  vaultsMessage,
} from "./messages";

const DEFAULT_SLIPPAGE_BPS = 50;


/** An input problem the user can fix by retyping the command. */
class UsageError extends Error {}

/** Plain-text description for logs. */
export function describeError(error: unknown): string {
  if (error instanceof UsageError) return error.message;
  if (error instanceof ApiError) return `API error ${error.status} (${error.code}): ${error.message}`;
  if (error instanceof Error && error.name === "TimeoutError") return "The Hedge Vault API did not answer in time. Try again.";
  return "Something went wrong. Check the bot logs.";
}

function errorReply(error: unknown): string {
  if (error instanceof ApiError) return errorMessage(`API error ${error.status} (${error.code})`, error.message);
  return errorMessage(describeError(error));
}

function replyHtml(ctx: Context, html: string) {
  return ctx.reply(fitMessage(html), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

function args(payload: string): string[] {
  return payload.split(/\s+/).filter(Boolean);
}

/** Small numbers pick from /vaults; otherwise match an address exactly or a name ignoring case. */
async function resolveVault(api: HedgeApi, reference: string | undefined, usage: string): Promise<VaultSummary> {
  if (!reference) throw new UsageError(`Usage: ${usage}`);
  const vaults = await api.listVaults();
  const vault = /^\d{1,3}$/.test(reference)
    ? vaults[Number(reference) - 1]
    : vaults.find((v) => v.address === reference || v.name.toLowerCase() === reference.toLowerCase());
  if (!vault) throw new UsageError(`No vault "${reference}" for this API key. Send /vaults to see the list.`);
  return vault;
}

export function createBot(options: { token: string; allowedUserIds: ReadonlySet<number>; api: HedgeApi }): Telegraf {
  const { api } = options;
  const bot = new Telegraf(options.token);

  // Unknown users get no reply, so the bot does not confirm it exists.
  bot.use((ctx, next) => (ctx.from && options.allowedUserIds.has(ctx.from.id) ? next() : undefined));

  bot.start((ctx) => replyHtml(ctx, HELP_MESSAGE));
  bot.help((ctx) => replyHtml(ctx, HELP_MESSAGE));

  bot.command("vaults", async (ctx) => {
    await replyHtml(ctx, vaultsMessage(await api.listVaults()));
  });

  bot.command("holdings", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/holdings <vault>");
    await replyHtml(ctx, holdingsMessage(vault, await api.getHoldings(vault.address)));
  });

  bot.command("strategies", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/strategies <vault>");
    await replyHtml(ctx, strategiesMessage(vault, await api.getStrategies(vault.address)));
  });

  bot.command("quote", async (ctx) => {
    const usage = "/quote <vault> <inputMint> <outputMint> <amount> [slippageBps]";
    const [vaultRef, inputMint, outputMint, amountBaseUnits, slippage] = args(ctx.payload);
    if (!inputMint || !outputMint || !amountBaseUnits) throw new UsageError(`Usage: ${usage}`);
    if (!/^\d+$/.test(amountBaseUnits)) throw new UsageError("Amount must be a whole number of base units, e.g. 1000000 for 1 USDC.");
    if (slippage !== undefined && !/^\d{1,5}$/.test(slippage)) throw new UsageError("slippageBps must be a whole number, e.g. 50 for 0.5%.");
    const vault = await resolveVault(api, vaultRef, usage);
    const quote = await api.getQuote({
      vault: vault.address,
      inputMint,
      outputMint,
      amountBaseUnits,
      slippageBps: slippage === undefined ? DEFAULT_SLIPPAGE_BPS : Number(slippage),
    });
    await replyHtml(ctx, quoteMessage(quote));
  });

  bot.catch(async (error, ctx) => {
    if (!(error instanceof UsageError)) {
      console.error("[telegram-bot] update failed", { updateId: ctx.update.update_id, error: describeError(error) });
    }
    await replyHtml(ctx, errorReply(error)).catch(() => undefined);
  });

  return bot;
}
