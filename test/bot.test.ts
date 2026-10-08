import { Telegram } from "telegraf";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Update } from "telegraf/types";
import type { HedgeApi } from "../src/api";
import { createBot } from "../src/bot";

function commandUpdate(fromId: number, text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  };
}

function setup() {
  const api: HedgeApi = {
    listVaults: vi.fn(async () => [
      { address: "Vau1t1111111111111111111111111111111111111111", name: "Demo", status: "active", depositSymbol: "USDC", depositDecimals: 6, totalAssets: "1500000" },
    ]),
  };
  const bot = createBot({ token: "123:test", allowedUserIds: new Set([42]), api });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "hv_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const replies: string[] = [];
  // handleUpdate builds a fresh Telegram client per update, so stub the prototype.
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method === "sendMessage") replies.push((payload as { text: string }).text);
    return true as never;
  });
  return { api, bot, replies };
}

describe("bot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers /vaults for an allowed user", async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(commandUpdate(42, "/vaults"));
    expect(replies).toEqual(["Demo (active)\n  Vau1…1111\n  TVL 1.5 USDC"]);
  });
  it("ignores users outside the allowlist without calling the API", async () => {
    const { api, bot, replies } = setup();
    await bot.handleUpdate(commandUpdate(7, "/vaults"));
    expect(replies).toEqual([]);
    expect(api.listVaults).not.toHaveBeenCalled();
  });
});
