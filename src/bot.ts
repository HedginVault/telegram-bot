import { ApiError, type HedgeClient, type Outcome, type Progress, type TransactionSigner, type VaultSummary } from "@hedginvault/sdk";
import { type Context, Telegraf, TelegramError } from "telegraf";
import { callbackQuery, message } from "telegraf/filters";
import { type PendingAction, toActionRequest } from "./actions";
import { InputError, applyFormOp, applyFormText } from "./forms";
import { HELP_MESSAGE, errorMessage, executionMessage, fitMessage } from "./messages";
import { type ScreenDeps, renderScreen } from "./screens";
import { type RenderedScreen, type Screen, ScreenNotice, type TextField, button, createIdStore, decodeScreen, keyboard } from "./ui";

/** An input problem the user can fix by retyping the command. */
class UsageError extends Error {}

/** Plain-text description for logs. */
export function describeError(error: unknown): string {
  if (error instanceof UsageError || error instanceof ScreenNotice || error instanceof InputError) return error.message;
  if (error instanceof ApiError) return `API error ${error.status} (${error.code}): ${error.message}`;
  if (error instanceof Error && error.name === "TimeoutError") return "The Hedge Vault API did not answer in time. Try again.";
  return "Something went wrong. Check the bot logs.";
}

const isUserFacing = (error: unknown) => error instanceof UsageError || error instanceof ScreenNotice || error instanceof InputError;

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

/** Small numbers pick from /vaults; otherwise match an address exactly or a name ignoring case. */
async function resolveVault(api: HedgeClient, reference: string | undefined, usage: string): Promise<VaultSummary> {
  if (!reference) throw new UsageError(`Usage: ${usage}`);
  const vaults = await api.listVaults();
  const vault = /^\d{1,3}$/.test(reference)
    ? vaults[Number(reference) - 1]
    : vaults.find((v) => v.address === reference || v.name.toLowerCase() === reference.toLowerCase());
  if (!vault) throw new UsageError(`No vault "${reference}" for this API key. Send /vaults to see the list.`);
  return vault;
}

export interface Trading {
  /** Signs as the vault manager; the SDK refuses transactions it did not expect this key to pay for. */
  signer: TransactionSigner;
}

/** The form field a chat is typing into, and the messages to tidy up once it answers. */
interface AwaitingInput {
  formId: string;
  field: TextField;
  formMessageId: number;
  promptMessageId: number;
}

export function createBot(options: {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  api: HedgeClient;
  /** Absent means read-only: no trade buttons, nothing signs. */
  trading?: Trading;
  /** Actions outlive their button tap; tests pass a collector to await them. */
  runInBackground?: (task: Promise<void>) => void;
}): Telegraf {
  const { api, trading } = options;
  const deps: ScreenDeps = {
    api,
    positions: createIdStore(),
    actions: createIdStore(),
    forms: createIdStore(),
    trading: trading !== undefined,
  };
  const render = (screen: Screen) => renderScreen(screen, deps);
  const runInBackground = options.runInBackground ?? ((task: Promise<void>) => void task);
  const bot = new Telegraf(options.token);
  // ponytail: one action at a time for the whole bot; per-vault locks if several managers share it.
  let executing = false;
  // ponytail: in memory, so a restart forgets half-typed answers; the form buttons expire too.
  const awaiting = new Map<number, AwaitingInput>();

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

  async function trackAction(ctx: Context, action: PendingAction, { signer }: Trading): Promise<void> {
    const progress: Progress[] = [];
    const done = keyboard([[button("⬅️ Vault", { kind: "vault", vault: action.vault }), button("🏦 Vaults", { kind: "vaults" })]]);
    const show = (outcome?: Outcome) =>
      editScreen(ctx, { html: executionMessage(action, progress, outcome), keyboard: outcome ? done : { inline_keyboard: [] } });
    try {
      await show();
      const outcome = await api.execute(toActionRequest(action), signer, {
        onProgress: async (step) => {
          progress.push(step);
          // A failed progress edit must not interrupt a transaction that is already in flight.
          await show().catch(() => undefined);
        },
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
  bot.help((ctx) => ctx.reply(HELP_MESSAGE, { ...HTML, reply_markup: keyboard([[button("🏦 Vaults", { kind: "vaults" })]]) }));
  bot.command("cancel", async (ctx) => {
    const wasTyping = awaiting.delete(ctx.chat.id);
    await ctx.reply(wasTyping ? "Cancelled. The form keeps its other values." : "Nothing to cancel.");
  });

  bot.command("holdings", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/holdings <vault>");
    await replyScreen(ctx, await render({ kind: "holdings", vault: vault.address }));
  });

  bot.command("strategies", async (ctx) => {
    const vault = await resolveVault(api, ctx.payload.trim(), "/strategies <vault>");
    await replyScreen(ctx, await render({ kind: "strategies", vault: vault.address }));
  });

  bot.on(callbackQuery("data"), async (ctx) => {
    const chatId = ctx.chat?.id;
    // Tapping any button abandons a half-typed answer.
    if (chatId !== undefined) awaiting.delete(chatId);
    const screen = decodeScreen(ctx.callbackQuery.data);
    if (!screen) {
      await ctx.answerCbQuery("Unknown button. Send /start.");
      return;
    }
    if (screen.kind === "execute") {
      await runAction(ctx, screen.actionId);
      return;
    }
    try {
      let target: Screen = screen;
      if (screen.kind === "formOp") {
        const result = await applyFormOp(screen.formId, screen.op, deps);
        if (result.kind === "ask") {
          await ctx.answerCbQuery();
          const prompt = await ctx.reply(result.prompt, { reply_markup: keyboard([[button("✖️ Cancel", { kind: "form", formId: screen.formId })]]) });
          const formMessageId = ctx.callbackQuery.message?.message_id;
          if (chatId !== undefined && formMessageId !== undefined) {
            awaiting.set(chatId, { formId: screen.formId, field: result.field, formMessageId, promptMessageId: prompt.message_id });
          }
          return;
        }
        target = result.screen;
      }
      const rendered = await render(target);
      await ctx.answerCbQuery();
      await editScreen(ctx, rendered);
    } catch (error) {
      // Form mistakes pop up over the form instead of scrolling the chat.
      if (error instanceof InputError) {
        await ctx.answerCbQuery(error.message, { show_alert: true });
        return;
      }
      await ctx.answerCbQuery().catch(() => undefined);
      throw error;
    }
  });

  bot.on(message("text"), async (ctx) => {
    const pending = awaiting.get(ctx.chat.id);
    if (!pending) {
      await ctx.reply("Send /start for the menu.");
      return;
    }
    try {
      await applyFormText(pending.formId, pending.field, ctx.message.text, deps);
    } catch (error) {
      if (error instanceof InputError) {
        await ctx.reply(`${error.message}\nTry again, or send /cancel.`);
        return;
      }
      throw error;
    }
    awaiting.delete(ctx.chat.id);
    // Move the form below the answer so it stays the newest message.
    await Promise.allSettled([ctx.deleteMessage(pending.promptMessageId), ctx.deleteMessage(pending.formMessageId)]);
    await replyScreen(ctx, await render({ kind: "form", formId: pending.formId }));
  });

  bot.catch(async (error, ctx) => {
    if (!isUserFacing(error)) {
      console.error("[telegram-bot] update failed", { updateId: ctx.update.update_id, error: describeError(error) });
    }
    await replyHtml(ctx, errorReply(error)).catch(() => undefined);
  });

  return bot;
}

