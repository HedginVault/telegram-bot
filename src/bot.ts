import type { Keypair } from "@solana/web3.js";
import { type Context, Markup, Telegraf, TelegramError } from "telegraf";
import { callbackQuery } from "telegraf/filters";
import { type PendingAction, toBuildRequest } from "./actions";
import { ApiError, type HedgeApi, type VaultSummary } from "./api";
import { type Outcome, type Progress, execute } from "./executor";
import { HELP_MESSAGE, errorMessage, executionMessage, fitMessage, quoteMessage } from "./messages";
import {
  DEFAULT_SLIPPAGE_BPS,
  type RenderedScreen,
  type Screen,
  type ScreenDeps,
  ScreenNotice,
  createIdStore,
  decodeScreen,
  encodeScreen,
  renderScreen,
} from "./screens";
import type { SigningPolicy } from "./signer";

/** An input problem the user can fix by retyping the command. */
class UsageError extends Error {}

/** Plain-text description for logs. */
export function describeError(error: unknown): string {
  if (error instanceof UsageError || error instanceof ScreenNotice) return error.message;
  if (error instanceof ApiError) return `API error ${error.status} (${error.code}): ${error.message}`;
  if (error instanceof Error && error.name === "TimeoutError") return "The Hedge Vault API did not answer in time. Try again.";
  return "Something went wrong. Check the bot logs.";
}

function errorReply(error: unknown): string {
  if (error instanceof ApiError) return errorMessage(`API error ${error.status} (${error.code})`, error.message);
  return errorMessage(describeError(error));
}

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

function replyHtml(ctx: Context, html: string) {
  return ctx.reply(fitMessage(html), HTML);
}

function replyScreen(ctx: Context, screen: RenderedScreen) {
  return ctx.reply(fitMessage(screen.html), { ...HTML, reply_markup: screen.keyboard });
}

/** Button taps edit the message they belong to, so the chat stays one live panel. */
async function editScreen(ctx: Context, screen: RenderedScreen): Promise<void> {
  try {
    await ctx.editMessageText(fitMessage(screen.html), { ...HTML, reply_markup: screen.keyboard });
  } catch (error) {
    // Refresh with unchanged data is not a failure.
    if (!(error instanceof TelegramError && error.description.includes("message is not modified"))) throw error;
  }
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

export interface Trading {
  manager: Keypair;
  policy: SigningPolicy;
}

export function createBot(options: {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  api: HedgeApi;
  /** Absent means read-only: no trade buttons, nothing signs. */
  trading?: Trading;
  /** Actions outlive their button tap; tests pass a collector to await them. */
  runInBackground?: (task: Promise<void>) => void;
}): Telegraf {
  const { api, trading } = options;
  const deps: ScreenDeps = {
    api,
    pairs: createIdStore(),
    positions: createIdStore(),
    actions: createIdStore(),
    trading: trading !== undefined,
  };
  const render = (screen: Screen) => renderScreen(screen, deps);
  const runInBackground = options.runInBackground ?? ((task: Promise<void>) => void task);
  const bot = new Telegraf(options.token);
  // ponytail: one action at a time for the whole bot; per-vault locks if several managers share it.
  let executing = false;

  async function runAction(ctx: Context, actionId: string): Promise<void> {
    if (!trading) throw new ScreenNotice("Trading is off. Set MANAGER_KEYPAIR_PATH to enable it.");
    if (executing) {
      await ctx.answerCbQuery("Another transaction is still running. Wait for it to finish.", { show_alert: true });
      return;
    }
    const action = deps.actions.take(actionId);
    if (!action) throw new ScreenNotice("This confirmation was already used or has expired. Start again from /start.");
    executing = true;
    await ctx.answerCbQuery();
    runInBackground(trackAction(ctx, action, trading));
  }

  async function trackAction(ctx: Context, action: PendingAction, { manager, policy }: Trading): Promise<void> {
    const progress: Progress[] = [];
    const done = Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Vault", encodeScreen({ kind: "vault", vault: action.vault })), Markup.button.callback("🏦 Vaults", encodeScreen({ kind: "vaults" }))],
    ]).reply_markup;
    const show = (outcome?: Outcome) =>
      editScreen(ctx, { html: executionMessage(action, progress, outcome), keyboard: outcome ? done : { inline_keyboard: [] } });
    try {
      await show();
      const outcome = await execute(toBuildRequest(action), { api, manager, policy }, async (step) => {
        progress.push(step);
        // A failed progress edit must not interrupt a transaction that is already in flight.
        await show().catch(() => undefined);
      });
      console.info("[telegram-bot] action finished", { action: action.kind, vault: action.vault, outcome: outcome.kind, signatures: outcome.signatures });
      await show(outcome);
    } catch (error) {
      console.error("[telegram-bot] action crashed", { action: action.kind, error: describeError(error) });
      await replyHtml(ctx, errorReply(error)).catch(() => undefined);
    } finally {
      executing = false;
    }
  }

  // Unknown users get no reply, so the bot does not confirm it exists.
  bot.use((ctx, next) => (ctx.from && options.allowedUserIds.has(ctx.from.id) ? next() : undefined));

  bot.start(async (ctx) => replyScreen(ctx, await render({ kind: "vaults" })));
  bot.command("vaults", async (ctx) => replyScreen(ctx, await render({ kind: "vaults" })));
  bot.help((ctx) =>
    ctx.reply(HELP_MESSAGE, {
      ...HTML,
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🏦 Vaults", encodeScreen({ kind: "vaults" }))]]).reply_markup,
    }),
  );

  bot.command("holdings", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/holdings <vault>");
    await replyScreen(ctx, await render({ kind: "holdings", vault: vault.address }));
  });

  bot.command("strategies", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/strategies <vault>");
    await replyScreen(ctx, await render({ kind: "strategies", vault: vault.address }));
  });

  bot.on(callbackQuery("data"), async (ctx) => {
    const screen = decodeScreen(ctx.callbackQuery.data);
    if (!screen) {
      await ctx.answerCbQuery("Unknown button. Send /start.");
      return;
    }
    if (screen.kind === "execute") {
      await runAction(ctx, screen.actionId);
      return;
    }
    // Stop the button's loading spinner right away; rendering can take a few API calls.
    await ctx.answerCbQuery();
    await editScreen(ctx, await render(screen));
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
    if (!(error instanceof UsageError || error instanceof ScreenNotice)) {
      console.error("[telegram-bot] update failed", { updateId: ctx.update.update_id, error: describeError(error) });
    }
    await replyHtml(ctx, errorReply(error)).catch(() => undefined);
  });

  return bot;
}
