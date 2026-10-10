import { ApiError, type HedgeClient, type Outcome, type Progress, type TransactionSigner, type VaultSummary, keypairSigner } from "@hedginvault/sdk";
import { type Context, Telegraf, TelegramError } from "telegraf";
import { callbackQuery, message } from "telegraf/filters";
import { type PendingAction, actionScope, actionVault, executeAction } from "./actions";
import { InputError, applyFormOp, applyFormText } from "./forms";
import { HELP_MESSAGE, errorHint, errorMessage, executionMessage, fitMessage } from "./messages";
import { type ScreenDeps, renderScreen } from "./screens";
import { type RenderedScreen, type Screen, ScreenNotice, type TextField, button, createIdStore, decodeScreen, isWalletScreen, keyboard } from "./ui";
import { EXPORT_VISIBLE_SECONDS, type WalletInput, type WalletResult, applyWalletText, walletScreen } from "./wallet-screens";
import { WalletError, type WalletStore, parseSecretKey } from "./wallets";

/** An input problem the user can fix by retyping the command. */
class UsageError extends Error {}

/** Plain-text description for logs. */
export function describeError(error: unknown): string {
  if (error instanceof UsageError || error instanceof ScreenNotice || error instanceof InputError || error instanceof WalletError) return error.message;
  if (error instanceof ApiError) return `API error ${error.status} (${error.code}): ${error.message}`;
  if (error instanceof Error && error.name === "TimeoutError") return "The Hedge Vault API did not answer in time. Try again.";
  return "Something went wrong. Check the bot logs.";
}

const isUserFacing = (error: unknown) =>
  error instanceof UsageError || error instanceof ScreenNotice || error instanceof InputError || error instanceof WalletError;

function errorReply(error: unknown): string {
  if (error instanceof ApiError) {
    // Screens and commands only read, so a missing scope here is "read".
    const hint = errorHint(error.code, error.message, "read");
    return errorMessage(`API error ${error.status} (${error.code})`, hint ? `${error.message}\n${hint}` : error.message);
  }
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
  if (!vault) throw new UsageError(`No vault "${reference}" for your active wallet. Send /vaults to see the list.`);
  return vault;
}

function looksLikePrivateKey(text: string): boolean {
  try {
    parseSecretKey(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One user's active wallet with its API client and button stores. Switching wallets builds a
 * new session, so buttons made for the old wallet expire instead of acting with the new one.
 */
interface Session {
  walletId: string;
  apiKey: string;
  deps: ScreenDeps;
  /** Signs as the vault manager; the SDK refuses transactions it did not expect this key to pay for. */
  signer: TransactionSigner;
  executing: boolean;
}

/** What a chat is typing into, and the messages to tidy up once it answers. */
type AwaitingInput =
  | { kind: "form"; formId: string; field: TextField; formMessageId: number; promptMessageId: number }
  | { kind: "wallet"; input: WalletInput; promptMessageId: number };

export function createBot(options: {
  token: string;
  /** Unset means anyone can use the bot. */
  allowedUserIds?: ReadonlySet<number>;
  wallets: WalletStore;
  /** An API client acting with one wallet's API key. */
  clientFor: (apiKey: string) => HedgeClient;
  /** Actions outlive their button tap; tests pass a collector to await them. */
  runInBackground?: (task: Promise<void>) => void;
}): Telegraf {
  const { wallets, clientFor } = options;
  const runInBackground = options.runInBackground ?? ((task: Promise<void>) => void task);
  const bot = new Telegraf(options.token);
  // ponytail: in memory and never evicted, so a restart forgets half-typed answers and expires every
  // session's buttons; evict idle sessions if memory grows with public users.
  const sessions = new Map<number, Session>();
  const awaiting = new Map<number, AwaitingInput>();

  /** The user's active session, or undefined when they still need a wallet with an API key. */
  function sessionOf(userId: number): Session | undefined {
    const active = wallets.active(userId);
    const apiKey = active && wallets.apiKey(userId, active.id);
    if (!active || !apiKey) return undefined;
    const current = sessions.get(userId);
    if (current?.walletId === active.id && current.apiKey === apiKey) return current;
    const session: Session = {
      walletId: active.id,
      apiKey,
      deps: { api: clientFor(apiKey), positions: createIdStore(), actions: createIdStore(), forms: createIdStore() },
      signer: keypairSigner(wallets.keypair(userId, active.id)),
      executing: false,
    };
    sessions.set(userId, session);
    return session;
  }

  const walletMenu = (userId: number) => {
    const result = walletScreen({ kind: "wallet" }, userId, wallets);
    if (result.kind !== "show") throw new Error("the wallet menu always shows");
    return result.screen;
  };

  /** Vault screens need a wallet with an API key; without one the user lands on the wallet menu. */
  async function renderFor(userId: number, screen: Screen): Promise<RenderedScreen> {
    const session = sessionOf(userId);
    return session ? renderScreen(screen, session.deps) : walletMenu(userId);
  }

  async function runAction(ctx: Context, session: Session, actionId: string): Promise<void> {
    if (session.executing) {
      await ctx.answerCbQuery("Another transaction is still running. Wait for it to finish.", { show_alert: true });
      return;
    }
    const action = session.deps.actions.take(actionId);
    if (!action) throw new ScreenNotice("This confirmation was already used or has expired. Start again from /start.");
    session.executing = true;
    await ctx.answerCbQuery();
    runInBackground(trackAction(ctx, action, session));
  }

  async function trackAction(ctx: Context, action: PendingAction, session: Session): Promise<void> {
    const { signer } = session;
    const { api } = session.deps;
    const progress: Progress[] = [];
    const vault = actionVault(action);
    const scope = actionScope(action);
    const done = (outcome: Outcome) => {
      const created = outcome.kind === "confirmed" ? outcome.created?.vault : undefined;
      return keyboard([
        [
          ...(created ? [button("🏦 Open new vault", { kind: "vault", vault: created })] : []),
          ...(vault ? [button("⬅️ Vault", { kind: "vault", vault })] : []),
          button("🏦 Vaults", { kind: "vaults" }),
        ],
      ]);
    };
    const show = (outcome?: Outcome) =>
      editScreen(ctx, { html: executionMessage(action, progress, outcome, scope), keyboard: outcome ? done(outcome) : { inline_keyboard: [] } });
    try {
      await show();
      const outcome = await executeAction(api, action, signer, {
        onProgress: async (step) => {
          progress.push(step);
          // A failed progress edit must not interrupt a transaction that is already in flight.
          await show().catch(() => undefined);
        },
      });
      console.info("[telegram-bot] action finished", { action: action.kind, vault, outcome: outcome.kind, signatures: outcome.signatures });
      await show(outcome);
    } catch (error) {
      console.error("[telegram-bot] action crashed", { action: action.kind, error: describeError(error) });
      await replyHtml(ctx, errorReply(error)).catch(() => undefined);
    } finally {
      session.executing = false;
    }
  }

  /** Shows a wallet result; a revealed key goes in its own protected message that deletes itself. */
  async function showWalletResult(ctx: Context, result: WalletResult, show: (screen: RenderedScreen) => Promise<unknown>): Promise<void> {
    if (result.kind === "reveal") {
      const secret = await ctx.reply(result.secretHtml, { ...HTML, protect_content: true });
      // ponytail: a timer, so a restart inside the window leaves the message; the user can delete it too.
      setTimeout(() => void ctx.deleteMessage(secret.message_id).catch(() => undefined), EXPORT_VISIBLE_SECONDS * 1000).unref();
      await replyScreen(ctx, result.screen);
      return;
    }
    if (result.kind === "show") await show(result.screen);
  }

  async function checkApiKey(apiKey: string): Promise<void> {
    try {
      await clientFor(apiKey).listVaults();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw new WalletError("The API rejected that key: it is wrong, revoked, or expired.");
      throw error;
    }
  }

  // Keys get pasted here, so the bot never works in groups where others could read them.
  bot.use((ctx, next) => (ctx.chat?.type === "private" ? next() : undefined));
  // With an allowlist, unknown users get no reply, so the bot does not confirm it exists.
  bot.use((ctx, next) => (ctx.from && (!options.allowedUserIds || options.allowedUserIds.has(ctx.from.id)) ? next() : undefined));

  bot.start(async (ctx) => replyScreen(ctx, await renderFor(ctx.from.id, { kind: "vaults" })));
  bot.command("vaults", async (ctx) => replyScreen(ctx, await renderFor(ctx.from.id, { kind: "vaults" })));
  bot.command("wallet", (ctx) => replyScreen(ctx, walletMenu(ctx.from.id)));
  bot.help((ctx) => ctx.reply(HELP_MESSAGE, { ...HTML, reply_markup: keyboard([[button("🏦 Vaults", { kind: "vaults" })]]) }));
  bot.command("cancel", async (ctx) => {
    const wasTyping = awaiting.delete(ctx.chat.id);
    await ctx.reply(wasTyping ? "Cancelled. The form keeps its other values." : "Nothing to cancel.");
  });

  const vaultCommands = [
    ["holdings", "vault"],
    ["strategies", "strategies"],
    ["nav", "navHistory"],
    ["requests", "requests"],
    ["history", "strategyHistory"],
    ["phoenix", "phoenix"],
    ["settings", "settings"],
  ] as const;
  for (const [command, kind] of vaultCommands) {
    bot.command(command, async (ctx) => {
      const session = sessionOf(ctx.from.id);
      if (!session) return replyScreen(ctx, walletMenu(ctx.from.id));
      const vault = await resolveVault(session.deps.api, ctx.payload.trim(), `/${command} <vault>`);
      return replyScreen(ctx, await renderScreen({ kind, vault: vault.address }, session.deps));
    });
  }

  bot.on(callbackQuery("data"), async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat?.id;
    // Tapping any button abandons a half-typed answer.
    if (chatId !== undefined) awaiting.delete(chatId);
    const screen = decodeScreen(ctx.callbackQuery.data);
    if (!screen) {
      await ctx.answerCbQuery("Unknown button. Send /start.");
      return;
    }
    try {
      if (isWalletScreen(screen)) {
        const result = walletScreen(screen, userId, wallets);
        await ctx.answerCbQuery();
        if (result.kind === "ask") {
          const prompt = await ctx.reply(result.prompt, { reply_markup: keyboard([[button("✖️ Cancel", { kind: "wallet" })]]) });
          if (chatId !== undefined) awaiting.set(chatId, { kind: "wallet", input: result.input, promptMessageId: prompt.message_id });
          return;
        }
        await showWalletResult(ctx, result, (rendered) => editScreen(ctx, rendered));
        return;
      }
      const session = sessionOf(userId);
      if (!session) {
        await ctx.answerCbQuery();
        await editScreen(ctx, walletMenu(userId));
        return;
      }
      if (screen.kind === "execute") {
        await runAction(ctx, session, screen.actionId);
        return;
      }
      let target: Screen = screen;
      if (screen.kind === "formOp") {
        const result = await applyFormOp(screen.formId, screen.op, session.deps);
        if (result.kind === "ask") {
          await ctx.answerCbQuery();
          const prompt = await ctx.reply(result.prompt, { reply_markup: keyboard([[button("✖️ Cancel", { kind: "form", formId: screen.formId })]]) });
          const formMessageId = ctx.callbackQuery.message?.message_id;
          if (chatId !== undefined && formMessageId !== undefined) {
            awaiting.set(chatId, { kind: "form", formId: screen.formId, field: result.field, formMessageId, promptMessageId: prompt.message_id });
          }
          return;
        }
        target = result.screen;
      }
      const rendered = await renderScreen(target, session.deps);
      await ctx.answerCbQuery();
      await editScreen(ctx, rendered);
    } catch (error) {
      // Form mistakes pop up over the form instead of scrolling the chat.
      if (error instanceof InputError || error instanceof WalletError) {
        await ctx.answerCbQuery(error.message, { show_alert: true });
        return;
      }
      await ctx.answerCbQuery().catch(() => undefined);
      throw error;
    }
  });

  bot.on(message("text"), async (ctx) => {
    const pending = awaiting.get(ctx.chat.id);
    if (pending?.kind === "wallet") {
      // The message holds a private key or API key: delete it before anything else can fail.
      await ctx.deleteMessage(ctx.message.message_id).catch(() => undefined);
      try {
        const screen = await applyWalletText(pending.input, ctx.message.text, ctx.from.id, wallets, checkApiKey);
        awaiting.delete(ctx.chat.id);
        await ctx.deleteMessage(pending.promptMessageId).catch(() => undefined);
        await replyScreen(ctx, screen);
      } catch (error) {
        if (error instanceof WalletError) {
          await ctx.reply(`${error.message}\nPaste it again, or send /cancel.`);
          return;
        }
        throw error;
      }
      return;
    }
    if (looksLikePrivateKey(ctx.message.text)) {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => undefined);
      await ctx.reply("That looked like a private key, so the bot deleted it. To add a wallet, use /wallet → 📥 Import wallet.");
      return;
    }
    const session = sessionOf(ctx.from.id);
    if (!pending || !session) {
      await ctx.reply("Send /start for the menu.");
      return;
    }
    let next: Screen | undefined;
    try {
      next = await applyFormText(pending.formId, pending.field, ctx.message.text, session.deps);
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
    await replyScreen(ctx, await renderScreen(next ?? { kind: "form", formId: pending.formId }, session.deps));
  });

  bot.catch(async (error, ctx) => {
    if (!isUserFacing(error)) {
      console.error("[telegram-bot] update failed", { updateId: ctx.update.update_id, error: describeError(error) });
    }
    await replyHtml(ctx, errorReply(error)).catch(() => undefined);
  });

  return bot;
}

