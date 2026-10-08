import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type BuiltStep,
  DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  type HedgeClient,
  executeBuild,
  keypairSigner,
  toBuildRequest,
} from "@hedginvault/sdk";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { type Trading, createBot } from "../src/bot";
import { POOL, SOL, USDC, VAULT, holdings, pool, poolSearch, quote, strategies, vaultSummary } from "./fixtures";

const ALLOWED_USER = 42;
const PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";

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

function setup(overrides: Partial<HedgeClient> = {}, trading?: Trading) {
  const api: HedgeClient = {
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
    searchPools: vi.fn(async () => poolSearch),
    getPool: vi.fn(async () => pool),
    getToken: vi.fn(async (_vault: string, mint: string) => ({ mint, symbol: "PASTED", decimals: 6, priceUsd: null, verified: false })),
    // The real SDK executor, running over this fake's build/send/status.
    execute: (request, signer, options) =>
      executeBuild(
        toBuildRequest(request),
        api,
        signer,
        { manager: signer.publicKey, programId: PROGRAM_ID, maxComputeUnitPriceMicroLamports: DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS },
        options,
      ),
    ...overrides,
  };
  const background: Promise<void>[] = [];
  const bot = createBot({ token: "123:test", allowedUserIds: new Set([ALLOWED_USER]), api, trading, runInBackground: (task) => background.push(task) });
  const settle = () => Promise.all(background);
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "hv_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const replies: string[] = [];
  const parseModes: unknown[] = [];
  const calls: { method: string; payload: SentPayload }[] = [];
  let nextMessageId = 100;
  // handleUpdate builds a fresh Telegram client per update, so stub the prototype.
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    const message = payload as SentPayload;
    calls.push({ method, payload: message });
    if (method === "sendMessage") {
      replies.push(message.text);
      parseModes.push(message.parse_mode);
      return { message_id: nextMessageId++, date: 0, chat: { id: ALLOWED_USER, type: "private" }, text: message.text } as never;
    }
    return true as never;
  });
  const send = (text: string, fromId = ALLOWED_USER) => bot.handleUpdate(commandUpdate(fromId, text));
  const tap = (data: string, fromId = ALLOWED_USER) => bot.handleUpdate(callbackUpdate(fromId, data));
  /** Send a plain chat message, like answering a form prompt. */
  const type = (text: string) =>
    bot.handleUpdate({
      update_id: 3,
      message: { message_id: 50, date: 0, chat: { id: ALLOWED_USER, type: "private", first_name: "T" }, from: { id: ALLOWED_USER, is_bot: false, first_name: "T" }, text },
    });
  const alerts = () =>
    calls.filter((c) => c.method === "answerCallbackQuery").map((c) => (c.payload as unknown as { text?: string }).text).filter(Boolean);
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
  /** Tap a form field button, then answer its prompt. */
  const fill = async (label: string, text: string) => {
    await click(label);
    await type(text);
  };
  return { api, send, tap, type, click, fill, buttons, lastScreen, calls, replies, parseModes, settle, alerts };
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

  it("resolves a vault by its /vaults number, address, or name", async () => {
    const { api, send, replies } = setup({ listVaults: vi.fn(async () => [{ ...vaultSummary, name: "Test Vault" }]) });
    await send("/holdings 1");
    await send(`/strategies ${VAULT}`);
    await send("/holdings test vault");
    expect(api.getHoldings).toHaveBeenCalledTimes(2);
    expect(api.getStrategies).toHaveBeenCalledWith(VAULT);
    expect(replies[0]).toMatch(/^📊 <b>Test Vault<\/b> · holdings/);
  });

  it("explains an unknown vault instead of calling the vault API", async () => {
    const { api, send, replies } = setup();
    await send("/holdings 9");
    await send("/holdings");
    expect(replies).toEqual(['❌ No vault "9" for this API key. Send /vaults to see the list.', "❌ Usage: /holdings &lt;vault&gt;"]);
    expect(api.getHoldings).not.toHaveBeenCalled();
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
    const { send, click, buttons, lastScreen, calls } = setup();
    await send("/start");
    await click("1. Demo");
    expect(buttons().map((b) => b.text)).toEqual(["📊 Holdings", "🧩 Strategies", "💱 Quote a swap", "🏦 Vaults"]);
    await click("📊 Holdings");
    expect(lastScreen().text).toMatch(/^📊 <b>Demo<\/b> · holdings/);
    await click("⬅️ Back");
    expect(lastScreen().text).toMatch(/^🏦 <b>Demo<\/b>/);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(3);
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

describe("swap form", () => {
  afterEach(() => vi.restoreAllMocks());

  it("quotes a held token with a typed amount and custom slippage, read-only", async () => {
    const { send, click, fill, buttons, lastScreen, api } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Quote a swap");
    expect(lastScreen().text).toContain("💱 <b>Swap</b> · buy with USDC");
    await click("🟢 Buying · tap to sell");
    await click("SOL");
    await fill("✏️ Amount", "0.004");
    await fill("✏️ Slippage", "0.8");
    expect(lastScreen().text).toContain("Amount 0.004 SOL");
    expect(lastScreen().text).toContain("Slippage 0.8%");
    await click("📈 Get quote");
    expect(api.getQuote).toHaveBeenLastCalledWith({ vault: VAULT, inputMint: SOL, outputMint: USDC, amount: "4000000", slippageBps: 80 });
    expect(lastScreen().text).toMatch(/^💱 <b>SOL → USDC<\/b>/);
    expect(buttons().map((b) => b.text)).toEqual(["🔄 Refresh", "✏️ Edit"]);
  });

  it("swaps a pasted contract address after warning that it is unverified", async () => {
    const MINT = "PastedMint111111111111111111111111111111111";
    const { send, click, fill, lastScreen, api, settle } = setup(tradingApi(), trading);
    await send("/start");
    await click("1. Demo");
    await click("💱 Swap");
    await fill("📋 Paste CA", MINT);
    expect(api.getToken).toHaveBeenCalledWith(VAULT, MINT);
    expect(lastScreen().text).toContain(`Token <b>PASTED</b> <code>${MINT}</code>`);
    expect(lastScreen().text).toContain("⚠️ <i>Not verified by Jupiter. Double-check the address.</i>");
    await fill("✏️ Amount", "0.5");
    await click("✓ 0.5%");
    await click("3%");
    await click("📈 Quote & review");
    await click("⚡ Swap USDC → PASTED");
    expect(lastScreen().text).toContain("<b>Swap 0.5 USDC → PASTED</b>");
    expect(lastScreen().text).toContain("Jupiter has not verified this token");
    await click("✅ Confirm and send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("jupiter/swap", { vault: VAULT, sourceMint: USDC, destinationMint: MINT, amount: "500000", slippageBps: 300 });
    expect(lastScreen().text).toContain("<b>Done.</b> 1 transaction(s) confirmed.");
  });

  it("keeps asking after bad input and stops on /cancel", async () => {
    const { send, click, type, replies, lastScreen } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Quote a swap");
    await click("📋 Paste CA");
    await type("not a mint");
    expect(replies.at(-1)).toBe("That is not a Solana address. Paste the token's mint address.\nTry again, or send /cancel.");
    await type(USDC);
    expect(replies.at(-1)).toBe("That is the deposit token, USDC. Paste the other token.\nTry again, or send /cancel.");
    await send("/cancel");
    expect(replies.at(-1)).toBe("Cancelled. The form keeps its other values.");
    await type("hello");
    expect(lastScreen().text).toBe("Send /start for the menu.");
  });

  it("refuses an exact amount larger than the vault holds at quote time", async () => {
    const { send, click, fill, alerts, api } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Quote a swap");
    await click("SOL");
    await fill("✏️ Amount", "5");
    await click("📈 Get quote");
    expect(alerts()).toContain("That is more than the vault holds.");
    expect(api.getQuote).not.toHaveBeenCalled();
  });

  it("expires form buttons it no longer knows", async () => {
    const { tap, replies } = setup();
    await tap("o:AAAAAAAAAAA:side");
    expect(replies.at(-1)).toBe("❌ This button expired. Send /start to begin again.");
  });
});

const manager = Keypair.generate();
const trading: Trading = { signer: keypairSigner(manager) };

function builtStep(): BuiltStep {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const message = new TransactionMessage({
    payerKey: manager.publicKey,
    recentBlockhash: blockhash,
    instructions: [new TransactionInstruction({ programId: new PublicKey(PROGRAM_ID), keys: [], data: Buffer.from([1]) })],
  }).compileToV0Message();
  return { transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), simulation: { unitsConsumed: 1 }, ticket: "t", blockhash };
}

/** An API that builds one manager-paid step per action and confirms it on the first poll. */
function tradingApi(): Partial<HedgeClient> {
  return {
    build: vi.fn(async () => [builtStep()]),
    send: vi.fn(async (transaction: string) => {
      const signature = bs58.encode(VersionedTransaction.deserialize(Buffer.from(transaction, "base64")).signatures[0] ?? new Uint8Array());
      return { signature, receipt: `r:${signature}`, status: "pending" as const };
    }),
    status: vi.fn(async () => ({ status: "confirmed" as const })),
  };
}

async function openSwapQuote(ui: ReturnType<typeof setup>) {
  await ui.send("/start");
  await ui.click("1. Demo");
  await ui.click("💱 Swap");
  await ui.click("🟢 Buying · tap to sell");
  await ui.click("SOL");
  await ui.click("25%");
  await ui.click("📈 Quote & review");
}

describe("trading", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows no trade or LP buttons without a manager keypair", async () => {
    const { send, click, buttons, lastScreen } = setup();
    await send("/start");
    await click("1. Demo");
    expect(buttons().map((b) => b.text)).not.toContain("➕ New LP position");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    expect(lastScreen().text).toContain("Trading is off");
    expect(buttons().map((b) => b.text)).toEqual(["🔄 Refresh", "⬅️ Strategies"]);
  });

  it("runs a confirmation only once even if tapped twice", async () => {
    const ui = setup(tradingApi(), trading);
    await openSwapQuote(ui);
    await ui.click("⚡ Swap SOL → USDC");
    const confirm = ui.buttons().find((b) => b.text === "✅ Confirm and send")?.callback_data ?? "";
    await ui.tap(confirm);
    await ui.settle();
    await ui.tap(confirm);
    expect(ui.api.build).toHaveBeenCalledTimes(1);
    expect(ui.api.build).toHaveBeenCalledWith("jupiter/swap", { vault: VAULT, sourceMint: SOL, destinationMint: USDC, amount: "2500000", slippageBps: 50 });
    expect(ui.replies.at(-1)).toBe("❌ This confirmation was already used or has expired. Start again from /start.");
  });

  it("refuses a second action while one is still running", async () => {
    let release: () => void = () => {};
    const api = tradingApi();
    api.build = vi.fn(() => new Promise<BuiltStep[]>((resolve) => (release = () => resolve([builtStep()]))));
    const { send, click, buttons, tap, alerts, settle } = setup(api, trading);
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    const claim = buttons().find((b) => b.text === "💰 Claim fees")?.callback_data ?? "";
    const remove = buttons().find((b) => b.text === "➖ 50%")?.callback_data ?? "";
    await tap(claim);
    await click("✅ Confirm and send");
    await tap(remove);
    await tap(buttons().find((b) => b.text === "✅ Confirm and send")?.callback_data ?? "");
    expect(alerts()).toContain("Another transaction is still running. Wait for it to finish.");
    release();
    await settle();
    expect(api.build).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["💰 Claim fees", "dlmm/claim-fee", { vault: VAULT, position: "Pos1111111111111111111111111111111111111111" }],
    ["➖ 50%", "dlmm/remove", { vault: VAULT, position: "Pos1111111111111111111111111111111111111111", bpsToRemove: 5000 }],
    ["🔁 Zap out to USDC", "dlmm/zap-out", { vault: VAULT, position: "Pos1111111111111111111111111111111111111111", slippageBps: 100 }],
  ])("builds %s on a DLMM position", async (label, action, body) => {
    const { send, click, api, settle } = setup(tradingApi(), trading);
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click(label);
    await click("✅ Confirm and send");
    await settle();
    expect(api.build).toHaveBeenCalledWith(action, body);
  });

  it("offers to close an empty swap strategy", async () => {
    const { send, click, api, settle } = setup(
      { ...tradingApi(), getStrategies: vi.fn(async () => [{ type: "jupiter" as const, address: "StratJup", symbol: "BONK", decimals: 5, vaultBalance: "0" }]) },
      trading,
    );
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("🗑 Close empty BONK strategy");
    await click("✅ Confirm and send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("strategy/close", { vault: VAULT, strategy: "StratJup" });
  });

  it("shows a refusal when the API builds a transaction for another payer", async () => {
    const other: Trading = { signer: keypairSigner(Keypair.generate()) };
    const { send, click, lastScreen, api, settle } = setup(tradingApi(), other);
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("💰 Claim fees");
    await click("✅ Confirm and send");
    await settle();
    expect(api.send).not.toHaveBeenCalled();
    expect(lastScreen().text).toMatch(/^🛑 /);
    expect(lastScreen().text).toContain("is not the signer's key");
  });
});

describe("LP form", () => {
  afterEach(() => vi.restoreAllMocks());

  async function newPosition(ui: ReturnType<typeof setup>) {
    await ui.send("/start");
    await ui.click("1. Demo");
    await ui.click("➕ New LP position");
  }

  it("opens a pasted pool with a custom shape, price range, and two-sided sizing", async () => {
    const ui = setup(tradingApi(), trading);
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    expect(ui.api.getPool).toHaveBeenCalledWith(VAULT, POOL);
    expect(ui.lastScreen().text).toContain("Pool <b>SOL/USDC</b> · 10 bps bins");
    await ui.click("📐 Shape: Spot · tap to change");
    await ui.click("📐 Shape: Curve · tap to change");
    await ui.fill("⬇️ Min price", "148");
    await ui.fill("⬆️ Max price", "152");
    expect(ui.lastScreen().text).toContain("Shape Bid-Ask");
    expect(ui.lastScreen().text).toContain("<i>29 bins, 147.9157 to 152.1137; holds both tokens.</i>");
    await ui.fill("💧 SOL amount", "0.005");
    await ui.fill("💧 USDC amount", "50%");
    expect(ui.lastScreen().text).toContain("SOL 0.005 SOL · vault has 0.01 SOL");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("<b>Open a SOL/USDC position with 0.005 SOL + 0.5 USDC</b>");
    expect(ui.lastScreen().text).toContain("Range 147.9157 to 152.1137 · 29 bins · Bid-Ask");
    await ui.click("✅ Confirm and send");
    await ui.settle();
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/open", {
      vault: VAULT,
      lbPair: POOL,
      lowerBinId: -114,
      upperBinId: -85,
      amountX: "5000000",
      amountY: "500000",
      shape: "bidAsk",
      maxActiveBinSlippage: 10,
    });
  });

  it("searches pools by symbol and keeps only pools with the deposit token", async () => {
    const ui = setup(tradingApi(), trading);
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", "sol");
    expect(ui.api.searchPools).toHaveBeenCalledWith(VAULT, "sol");
    expect(ui.buttons().map((b) => b.text)).toContain("SOL/USDC · 10 bps");
    expect(ui.buttons().map((b) => b.text)).not.toContain("SOL/BONK · 80 bps");
    await ui.click("SOL/USDC · 10 bps");
    expect(ui.lastScreen().text).toContain("Pool <b>SOL/USDC</b>");
  });

  it("offers only the token a one-sided range can hold and checks balances at review", async () => {
    const ui = setup(tradingApi(), trading);
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    await ui.fill("⬇️ Min price", "140");
    await ui.fill("⬆️ Max price", "149");
    expect(ui.lastScreen().text).toContain("holds only USDC");
    expect(ui.buttons().map((b) => b.text)).not.toContain("💧 SOL amount");
    await ui.fill("💧 USDC amount", "2");
    await ui.click("✅ Review");
    expect(ui.alerts()).toContain("That is more than the vault holds.");
    expect(ui.api.build).not.toHaveBeenCalled();
  });

  it("rejects a pasted pool that does not include the deposit token", async () => {
    const ui = setup({ ...tradingApi(), getPool: vi.fn(async () => ({ ...pool, tokenY: { mint: "Bonk111111111111111111111111111111111111111", symbol: "BONK", decimals: 5 } })) }, trading);
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    expect(ui.replies.at(-1)).toBe("That pool does not include the vault's deposit token, USDC.\nTry again, or send /cancel.");
  });

  it("adds liquidity to an existing position with its own shape and sizing", async () => {
    const ui = setup({ ...tradingApi(), getStrategies: vi.fn(async () => strategies.map((s) => (s.type === "dlmm" ? { ...s, lbPair: POOL } : s))) }, trading);
    await ui.send("/start");
    await ui.click("1. Demo");
    await ui.click("🧩 Strategies");
    await ui.click("⚙️ SOL/USDC position");
    await ui.click("➕ Add liquidity");
    expect(ui.lastScreen().text).toMatch(/^➕ <b>Add liquidity<\/b>/);
    expect(ui.buttons().map((b) => b.text)).not.toContain("⬇️ Min price");
    await ui.click("📐 Shape: Spot · tap to change");
    await ui.fill("💧 USDC amount", "max");
    await ui.click("✅ Review");
    await ui.click("✅ Confirm and send");
    await ui.settle();
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/add", {
      vault: VAULT,
      position: "Pos1111111111111111111111111111111111111111",
      amountX: "0",
      amountY: "1000000",
      shape: "curve",
      maxActiveBinSlippage: 10,
    });
  });
});
