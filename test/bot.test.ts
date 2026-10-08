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

function setup(overrides: Partial<HedgeApi> = {}) {
  const api: HedgeApi = {
    listVaults: vi.fn(async () => [vaultSummary]),
    getHoldings: vi.fn(async () => holdings),
    getStrategies: vi.fn(async () => strategies),
    getQuote: vi.fn(async () => quote),
    ...overrides,
  };
  const bot = createBot({ token: "123:test", allowedUserIds: new Set([ALLOWED_USER]), api });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "hv_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const replies: string[] = [];
  const parseModes: unknown[] = [];
  // handleUpdate builds a fresh Telegram client per update, so stub the prototype.
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method === "sendMessage") {
      const message = payload as { text: string; parse_mode?: string };
      replies.push(message.text);
      parseModes.push(message.parse_mode);
    }
    return true as never;
  });
  const send = (text: string, fromId = ALLOWED_USER) => bot.handleUpdate(commandUpdate(fromId, text));
  return { api, send, replies, parseModes };
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
