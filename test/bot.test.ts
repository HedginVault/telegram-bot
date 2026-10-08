import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type HedgeApi } from "../src/api";
import { createBot } from "../src/bot";
import { SOL, USDC, VAULT, holdings, quote, strategies, vaultSummary } from "./fixtures";

const ALLOWED_USER = 42;

function commandUpdate(fromId: number, text: string): Update {
  const command = text.split(" ")[0] ?? text;
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

function callbackUpdate(fromId: number, data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      data,
      from: { id: fromId, is_bot: false, first_name: "T" },
      message: { message_id: 9, date: 0, chat: { id: fromId, type: "private", first_name: "T" }, text: "old" },
    },
  };
}

interface SentPayload {
  text: string;
  parse_mode?: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

function setup(overrides: Partial<HedgeApi> = {}) {
  const api: HedgeApi = {
    listVaults: vi.fn(async () => [vaultSummary]),
    getHoldings: vi.fn(async () => holdings),
    getStrategies: vi.fn(async () => strategies),
    getQuote: vi.fn(async () => quote),
    build: vi.fn(async () => {
      throw new Error("unexpected build");
    }),
    send: vi.fn(async () => {
      throw new Error("unexpected send");
    }),
    status: vi.fn(async () => {
      throw new Error("unexpected status");
    }),
    ...overrides,
  };
  const bot = createBot({ token: "123:test", allowedUserIds: new Set([ALLOWED_USER]), api });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "hv_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const replies: string[] = [];
  const parseModes: unknown[] = [];
  const calls: { method: string; payload: SentPayload }[] = [];
  // handleUpdate builds a fresh Telegram client per update, so stub the prototype.
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    const message = payload as SentPayload;
    calls.push({ method, payload: message });
    if (method === "sendMessage") {
      replies.push(message.text);
      parseModes.push(message.parse_mode);
    }
    return true as never;
  });
  const send = (text: string, fromId = ALLOWED_USER) => bot.handleUpdate(commandUpdate(fromId, text));
  const tap = (data: string, fromId = ALLOWED_USER) => bot.handleUpdate(callbackUpdate(fromId, data));
  const screens = () => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => c.payload);
  const lastScreen = () => {
    const screen = screens().at(-1);
    if (!screen) throw new Error("no screen shown");
    return screen;
  };
  const buttons = () => (lastScreen().reply_markup?.inline_keyboard ?? []).flat();
  /** Tap the button with this label on the most recent screen, like a user would. */
  const click = async (label: string) => {
    const target = buttons().find((b) => b.text === label);
    if (!target) throw new Error(`no "${label}" button; have ${buttons().map((b) => b.text).join(", ")}`);
    await tap(target.callback_data);
  };
  return { api, send, tap, click, buttons, lastScreen, calls, replies, parseModes };
}

describe("bot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers /vaults for an allowed user as HTML", async () => {
    const { send, replies, parseModes } = setup();
    await send("/vaults");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`<b>1. Demo</b> · 🟢 normal\n<code>${VAULT}</code>`);
    expect(parseModes).toEqual(["HTML"]);
  });

  it("ignores users outside the allowlist without calling the API", async () => {
    const { api, send, replies } = setup();
    await send("/vaults", 7);
    await send("/holdings 1", 7);
    expect(replies).toEqual([]);
    expect(api.listVaults).not.toHaveBeenCalled();
    expect(api.getHoldings).not.toHaveBeenCalled();
  });

  it("resolves a vault by its /vaults number or by address", async () => {
    const { api, send, replies } = setup();
    await send("/holdings 1");
    await send(`/strategies ${VAULT}`);
    expect(api.getHoldings).toHaveBeenCalledWith(VAULT);
    expect(api.getStrategies).toHaveBeenCalledWith(VAULT);
    expect(replies[0]).toMatch(/^📊 <b>Demo<\/b> · holdings/);
    expect(replies[1]).toMatch(/^🧩 <b>Demo<\/b> · strategies \(4\)/);
  });

  it("resolves a vault by its name, ignoring case", async () => {
    const { api, send } = setup({ listVaults: vi.fn(async () => [{ ...vaultSummary, name: "Test Vault" }]) });
    await send("/holdings test vault");
    expect(api.getHoldings).toHaveBeenCalledWith(VAULT);
  });

  it("explains an unknown vault instead of calling the vault API", async () => {
    const { api, send, replies } = setup();
    await send("/holdings 9");
    await send("/holdings");
    expect(replies).toEqual([
      '❌ No vault "9" for this API key. Send /vaults to see the list.',
      "❌ Usage: /holdings &lt;vault&gt;",
    ]);
    expect(api.getHoldings).not.toHaveBeenCalled();
  });

  it("passes quote arguments through in base units with default slippage", async () => {
    const { api, send, replies } = setup();
    await send(`/quote 1 ${USDC} ${SOL} 1000000`);
    await send(`/quote 1 ${USDC} ${SOL} 1000000 25`);
    expect(api.getQuote).toHaveBeenNthCalledWith(1, { vault: VAULT, inputMint: USDC, outputMint: SOL, amountBaseUnits: "1000000", slippageBps: 50 });
    expect(api.getQuote).toHaveBeenNthCalledWith(2, { vault: VAULT, inputMint: USDC, outputMint: SOL, amountBaseUnits: "1000000", slippageBps: 25 });
    expect(replies[0]).toMatch(/^💱 <b>Jupiter quote<\/b>/);
  });

  it("rejects display-unit quote amounts before calling the API", async () => {
    const { api, send, replies } = setup();
    await send(`/quote 1 ${USDC} ${SOL} 1.5`);
    expect(replies).toEqual(["❌ Amount must be a whole number of base units, e.g. 1000000 for 1 USDC."]);
    expect(api.getQuote).not.toHaveBeenCalled();
  });

  it("shows the API's own error code and message", async () => {
    const { send, replies } = setup({
      getHoldings: vi.fn(async () => {
        throw new ApiError(403, "Forbidden", "Manager is not the current vault authority");
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await send("/holdings 1");
    expect(replies).toEqual(["❌ <b>API error 403 (Forbidden)</b>\nManager is not the current vault authority"]);
  });
});

describe("buttons", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the vault menu on /start", async () => {
    const { send, buttons, lastScreen } = setup();
    await send("/start");
    expect(lastScreen().text).toMatch(/^🏦 <b>Your vaults<\/b> \(1\)/);
    expect(buttons().map((b) => b.text)).toEqual(["1. Demo", "🔄 Refresh"]);
  });

  it("walks vault → holdings → back by tapping, editing one message", async () => {
    const { send, click, buttons, lastScreen, calls, api } = setup();
    await send("/start");
    await click("1. Demo");
    expect(lastScreen().text).toMatch(/^🏦 <b>Demo<\/b> · 🟢 normal/);
    expect(buttons().map((b) => b.text)).toEqual(["📊 Holdings", "🧩 Strategies", "💱 Quote a swap", "🏦 Vaults"]);
    await click("📊 Holdings");
    expect(api.getHoldings).toHaveBeenCalledWith(VAULT);
    expect(lastScreen().text).toMatch(/^📊 <b>Demo<\/b> · holdings/);
    await click("⬅️ Back");
    expect(lastScreen().text).toMatch(/^🏦 <b>Demo<\/b>/);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(3);
    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(3);
  });

  it("quotes a sell of 25% of the vault's SOL with readable amounts", async () => {
    const { send, click, buttons, lastScreen, api } = setup({
      getQuote: vi.fn(async () => ({ ...quote, inAmount: "2500000", outAmount: "375000" })),
    });
    await send("/start");
    await click("1. Demo");
    await click("💱 Quote a swap");
    expect(buttons().map((b) => b.text)).toEqual(["Sell SOL", "Buy SOL", "⬅️ Back"]);
    await click("Sell SOL");
    expect(lastScreen().text).toContain("Vault balance <b>0.01 SOL</b>");
    expect(buttons().map((b) => b.text)).toEqual(["10%", "25%", "50%", "100%", "⬅️ Back"]);
    await click("25%");
    expect(api.getQuote).toHaveBeenCalledWith({ vault: VAULT, inputMint: SOL, outputMint: USDC, amountBaseUnits: "2500000", slippageBps: 50 });
    expect(lastScreen().text).toContain("You give <b>0.0025 SOL</b>\nYou get  <b>≈ 0.375 USDC</b>");
  });

  it("quotes a buy using the vault's deposit balance", async () => {
    const { send, click, api } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Quote a swap");
    await click("Buy SOL");
    await click("50%");
    expect(api.getQuote).toHaveBeenCalledWith({ vault: VAULT, inputMint: USDC, outputMint: SOL, amountBaseUnits: "500000", slippageBps: 50 });
  });

  it("explains an expired quote button instead of quoting something else", async () => {
    const { tap, replies, api } = setup();
    await tap("qq:AAAAAAAAAAA:25");
    expect(api.getQuote).not.toHaveBeenCalled();
    expect(replies).toEqual(["❌ This button expired. Send /start to begin again."]);
  });

  it("ignores taps from users outside the allowlist", async () => {
    const { tap, calls, api } = setup();
    await tap(`h:${VAULT}`, 7);
    expect(calls).toEqual([]);
    expect(api.getHoldings).not.toHaveBeenCalled();
  });

  it("answers unknown button data without calling the API", async () => {
    const { tap, calls, api } = setup();
    await tap("h:../../etc");
    expect(api.listVaults).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });
});
