import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HedgeClient } from "@hedginxyz/sdk";
import { randomBytes } from "node:crypto";
import {
  ALERTS_CLAIM_FAILED,
  ALERTS_LINK_EXPIRED,
  ALERTS_NONE,
  ALERTS_NOT_SET_UP,
  ALERTS_OFF,
  ALERTS_ON,
  ALERTS_UNLINK_FAILED,
  type AlertsLink,
  createAlertsLink,
  isAlertLinkCode,
} from "../src/alerts-link";
import { createBot } from "../src/bot";
import { createWalletStore } from "../src/wallets";

const SECRET = "s".repeat(32);
const BASE = "https://app.test";
const CODE = "AbCdEfGhIjKlMnOpQrSt_-";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { fetchFn, calls };
}

describe("isAlertLinkCode", () => {
  it("accepts 22 base64url characters", () => {
    expect(isAlertLinkCode(CODE)).toBe(true);
    expect(isAlertLinkCode(randomBytes(16).toString("base64url"))).toBe(true);
  });
  it("rejects anything else", () => {
    for (const payload of ["", "short", `${CODE}x`, CODE.slice(1), "AbCdEfGhIjKlMnOpQrSt+/", `${CODE.slice(0, 21)}=`, ` ${CODE.slice(1)}`]) {
      expect(isAlertLinkCode(payload)).toBe(false);
    }
  });
});

describe("createAlertsLink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the code, chat, and username with the shared secret", async () => {
    const { fetchFn, calls } = fakeFetch(async () => jsonResponse(200, { ok: true, vaultCount: 2 }));
    const reply = await createAlertsLink(fetchFn, BASE, SECRET).claim({ code: CODE, chatId: "123456789", username: "alice" });
    expect(reply).toBe(ALERTS_ON);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/api/alerts/telegram/claim`);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toMatchObject({ "x-alerts-link-secret": SECRET, "content-type": "application/json" });
    expect(JSON.parse(String(call?.init?.body))).toEqual({ code: CODE, chatId: "123456789", username: "alice" });
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a null username as null", async () => {
    const { fetchFn, calls } = fakeFetch(async () => jsonResponse(200, { ok: true, vaultCount: 0 }));
    await createAlertsLink(fetchFn, BASE, SECRET).claim({ code: CODE, chatId: "1", username: null });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: CODE, chatId: "1", username: null });
  });

  it.each([404, 410])("says the link expired on %i", async (status) => {
    const { fetchFn } = fakeFetch(async () => jsonResponse(status, { error: "gone" }));
    expect(await createAlertsLink(fetchFn, BASE, SECRET).claim({ code: CODE, chatId: "1", username: null })).toBe(ALERTS_LINK_EXPIRED);
  });

  it("asks to retry on a server error, a network error, or a malformed answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses: (() => Promise<Response>)[] = [
      async () => jsonResponse(500, { error: "boom" }),
      async () => jsonResponse(401, { error: "bad secret" }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => jsonResponse(200, { ok: true }),
      async () => new Response("not json", { status: 200 }),
    ];
    for (const respond of responses) {
      const { fetchFn } = fakeFetch(respond);
      expect(await createAlertsLink(fetchFn, BASE, SECRET).claim({ code: CODE, chatId: "1", username: null })).toBe(ALERTS_CLAIM_FAILED);
    }
  });

  it("unlinks the chat and says whether anything was connected", async () => {
    const removed = fakeFetch(async () => jsonResponse(200, { ok: true, removed: 3 }));
    expect(await createAlertsLink(removed.fetchFn, BASE, SECRET).unlink("77")).toBe(ALERTS_OFF);
    expect(removed.calls[0]?.url).toBe(`${BASE}/api/alerts/telegram/unlink`);
    expect(removed.calls[0]?.init?.headers).toMatchObject({ "x-alerts-link-secret": SECRET });
    expect(JSON.parse(String(removed.calls[0]?.init?.body))).toEqual({ chatId: "77" });

    const none = fakeFetch(async () => jsonResponse(200, { ok: true, removed: 0 }));
    expect(await createAlertsLink(none.fetchFn, BASE, SECRET).unlink("77")).toBe(ALERTS_NONE);
  });

  it("asks to retry when unlinking fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = fakeFetch(async () => jsonResponse(503, {}));
    expect(await createAlertsLink(failed.fetchFn, BASE, SECRET).unlink("77")).toBe(ALERTS_UNLINK_FAILED);
    const offline = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await createAlertsLink(offline.fetchFn, BASE, SECRET).unlink("77")).toBe(ALERTS_UNLINK_FAILED);
  });

  it("does not call the app without a secret", async () => {
    const { fetchFn, calls } = fakeFetch(async () => jsonResponse(200, { ok: true, vaultCount: 1 }));
    const link = createAlertsLink(fetchFn, BASE, undefined);
    expect(await link.claim({ code: CODE, chatId: "1", username: null })).toBe(ALERTS_NOT_SET_UP);
    expect(await link.unlink("1")).toBe(ALERTS_NOT_SET_UP);
    expect(calls).toEqual([]);
  });
});

const ALLOWED_USER = 42;
const OUTSIDER = 7;

function commandUpdate(fromId: number, text: string, chatType: "private" | "group" = "private"): Update {
  const command = text.split(" ")[0] ?? text;
  const chat = chatType === "private" ? ({ id: fromId, type: "private", first_name: "T" } as const) : ({ id: -100, type: "group", title: "G" } as const);
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat,
      from: { id: fromId, is_bot: false, first_name: "T", username: "mgr" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

function setupBot(alerts: AlertsLink | undefined) {
  const api = { listVaults: vi.fn(async () => []) } as unknown as HedgeClient;
  const bot = createBot({
    token: "123:test",
    allowedUserIds: new Set([ALLOWED_USER]),
    wallets: createWalletStore(undefined, randomBytes(32)),
    clientFor: () => api,
    alerts,
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "hv_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const replies: string[] = [];
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method === "sendMessage") {
      const text = (payload as { text: string }).text;
      replies.push(text);
      return { message_id: 100, date: 0, chat: { id: ALLOWED_USER, type: "private" }, text } as never;
    }
    return true as never;
  });
  const send = (text: string, fromId = ALLOWED_USER, chatType: "private" | "group" = "private") =>
    bot.handleUpdate(commandUpdate(fromId, text, chatType));
  return { send, replies };
}

function spyLink(): AlertsLink & { claim: ReturnType<typeof vi.fn>; unlink: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn(async () => ALERTS_ON), unlink: vi.fn(async () => ALERTS_OFF) };
}

describe("bot alert linking", () => {
  afterEach(() => vi.restoreAllMocks());

  it("claims a link code for a user outside the allowlist", async () => {
    const link = spyLink();
    const { send, replies } = setupBot(link);
    await send(`/start ${CODE}`, OUTSIDER);
    expect(link.claim).toHaveBeenCalledWith({ code: CODE, chatId: String(OUTSIDER), username: "mgr" });
    expect(replies).toEqual([ALERTS_ON]);
  });

  it("turns alerts off for a user outside the allowlist", async () => {
    const link = spyLink();
    const { send, replies } = setupBot(link);
    await send("/alerts_off", OUTSIDER);
    expect(link.unlink).toHaveBeenCalledWith(String(OUTSIDER));
    expect(replies).toEqual([ALERTS_OFF]);
  });

  it("leaves /start without a code, or with a non-code payload, to the allowlist", async () => {
    const link = spyLink();
    const { send, replies } = setupBot(link);
    await send("/start", OUTSIDER);
    await send("/start hello", OUTSIDER);
    await send(`/start ${CODE}x`, OUTSIDER);
    expect(replies).toEqual([]);
    expect(link.claim).not.toHaveBeenCalled();
  });

  it("still opens the vault menu for an allowed /start with a non-code payload", async () => {
    const link = spyLink();
    const { send, replies } = setupBot(link);
    await send("/start hello");
    expect(link.claim).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toBe(ALERTS_ON);
  });

  it("ignores link codes in group chats", async () => {
    const link = spyLink();
    const { send, replies } = setupBot(link);
    await send(`/start ${CODE}`, OUTSIDER, "group");
    await send("/alerts_off", OUTSIDER, "group");
    expect(replies).toEqual([]);
    expect(link.claim).not.toHaveBeenCalled();
    expect(link.unlink).not.toHaveBeenCalled();
  });

  it("says alerts are not set up when the bot has no alerts link", async () => {
    const { send, replies } = setupBot(undefined);
    await send(`/start ${CODE}`, OUTSIDER);
    await send("/alerts_off", OUTSIDER);
    expect(replies).toEqual([ALERTS_NOT_SET_UP, ALERTS_NOT_SET_UP]);
  });
});
