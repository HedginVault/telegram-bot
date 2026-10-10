import { Telegram } from "telegraf";
import type { Update } from "telegraf/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type BuiltStep,
  DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  type HedgeClient,
  executeBuild,
  toBuildRequest,
} from "@hedginvault/sdk";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { createBot } from "../src/bot";
import { createWalletStore } from "../src/wallets";
import {
  POOL,
  SOL,
  USDC,
  VAULT,
  holdings,
  navHistory,
  phoenixNone,
  phoenixReady,
  phoenixRegistered,
  pool,
  poolSearch,
  quote,
  requestQueue,
  strategies,
  strategyHistory,
  vaultDetail,
  vaultSummary,
} from "./fixtures";

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
  protect_content?: boolean;
  text: string;
  parse_mode?: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** The active wallet of ALLOWED_USER; trading tests build transactions it pays for. */
const manager = Keypair.generate();
const API_KEY = `hv1_test_${"a".repeat(64)}`;

/** `wallet: null` starts the user with no wallet at all. */
function setup(overrides: Partial<HedgeClient> = {}, wallet: Keypair | null = manager) {
  const api: HedgeClient = {
    listVaults: vi.fn(async () => [vaultSummary]),
    getHoldings: vi.fn(async () => holdings),
    getStrategies: vi.fn(async () => strategies),
    getVault: vi.fn(async () => vaultDetail),
    getNavHistory: vi.fn(async () => navHistory),
    getRequests: vi.fn(async () => requestQueue),
    getStrategyHistory: vi.fn(async () => strategyHistory),
    getPhoenix: vi.fn(async () => phoenixReady),
    onboardPhoenix: vi.fn(async () => {
      throw new Error("unexpected onboard");
    }),
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
  const wallets = createWalletStore(undefined, randomBytes(32));
  const listedWith: string[] = [];
  if (wallet) wallets.setApiKey(ALLOWED_USER, wallets.add(ALLOWED_USER, wallet, "imported").wallet.id, API_KEY);
  const bot = createBot({
    token: "123:test",
    allowedUserIds: new Set([ALLOWED_USER]),
    wallets,
    // Records which wallet API key each vault list was read with.
    clientFor: (apiKey) => ({
      ...api,
      listVaults: () => {
        listedWith.push(apiKey);
        return api.listVaults();
      },
    }),
    runInBackground: (task) => background.push(task),
  });
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
  return { api, bot, wallets, listedWith, send, tap, type, click, fill, buttons, lastScreen, calls, replies, parseModes, settle, alerts };
}

describe("bot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers /vaults for an allowed user as HTML", async () => {
    const { send, replies, parseModes } = setup();
    await send("/vaults");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`<b>1. Demo</b> · 🟢 normal\n└ <b>1.5 USDC</b> · <a href="https://solscan.io/account/${VAULT}">Vau1…1111 ↗</a>`);
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
    expect(replies[0]).toMatch(/^🏦 <b>Test Vault<\/b> · 🟢 normal/);
  });

  it("explains an unknown vault instead of calling the vault API", async () => {
    const { api, send, replies } = setup();
    await send("/holdings 9");
    await send("/holdings");
    expect(replies).toEqual(['❌ No vault "9" for your active wallet. Send /vaults to see the list.', "❌ Usage: /holdings &lt;vault&gt;"]);
    expect(api.getHoldings).not.toHaveBeenCalled();
  });

  it("shows the API's own error code and message", async () => {
    const { send, replies } = setup({
      getStrategies: vi.fn(async () => {
        throw new ApiError(403, "Forbidden", "Manager is not the current vault authority");
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await send("/strategies 1");
    expect(replies).toEqual(["❌ <b>API error 403 (Forbidden)</b>\nManager is not the current vault authority"]);
  });
});

describe("buttons", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the vault menu on /start", async () => {
    const { send, buttons, lastScreen } = setup();
    await send("/start");
    expect(lastScreen().text).toMatch(/^🏦 <b>Your vaults<\/b> \(1\)/);
    expect(buttons().map((b) => b.text)).toEqual(["1. Demo", "✨ Create vault", "🔄 Refresh", "👛 Wallet"]);
  });

  it("walks vault → strategies → back by tapping, editing one message", async () => {
    const { send, click, buttons, lastScreen, calls, api } = setup();
    await send("/start");
    await click("1. Demo");
    expect(api.getHoldings).toHaveBeenCalledWith(VAULT);
    expect(lastScreen().text).toContain("💰 <b>2.5 USDC</b> ≈ $2.50 · vs NAV 🟢 +4.17%");
    expect(buttons().map((b) => b.text)).toEqual([
      "💱 Swap",
      "➕ New LP",
      "🧩 Strategies",
      "📈 Phoenix",
      "📊 NAV history",
      "📋 Requests",
      "🗂 History",
      "⚙️ Settings",
      "🔄 Refresh",
      "🏦 Vaults",
    ]);
    await click("🧩 Strategies");
    expect(lastScreen().text).toMatch(/^🧩 <b>Demo<\/b> · strategies/);
    await click("⬅️ Back");
    expect(lastScreen().text).toMatch(/^🏦 <b>Demo<\/b>/);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(3);
  });

  it("lays vault buttons out two to a row", async () => {
    const { send, lastScreen } = setup({ listVaults: vi.fn(async () => [vaultSummary, { ...vaultSummary, name: "B" }, { ...vaultSummary, name: "C" }]) });
    await send("/start");
    const rows = lastScreen().reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text));
    expect(rows?.slice(0, 2)).toEqual([["1. Demo", "2. B"], ["3. C"]]);
  });

  it("ignores taps from users outside the allowlist", async () => {
    const { tap, calls, api } = setup();
    await tap(`v:${VAULT}`, 7);
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

  it("quotes a held token with a typed amount and custom slippage", async () => {
    const { send, click, fill, buttons, lastScreen, api } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Swap");
    expect(lastScreen().text).toContain("💱 <b>Swap</b> · buy with USDC");
    await click("🟢 Buying · tap to sell");
    await click("SOL");
    await fill("✏️ Amount", "0.004");
    await fill("✏️ Slippage", "0.8");
    expect(lastScreen().text).toContain("Amount 0.004 SOL");
    expect(lastScreen().text).toContain("Slippage 0.8%");
    await click("📈 Quote & review");
    expect(api.getQuote).toHaveBeenLastCalledWith({ vault: VAULT, inputMint: SOL, outputMint: USDC, amount: "4000000", slippageBps: 80 });
    expect(lastScreen().text).toMatch(/^💱 <b>SOL → USDC<\/b>/);
    expect(buttons().map((b) => b.text)).toEqual(["⚡ Swap SOL → USDC", "🔄 Refresh", "✏️ Edit"]);
  });

  it("swaps a pasted contract address after warning that it is unverified", async () => {
    const MINT = "PastedMint111111111111111111111111111111111";
    const { send, click, fill, lastScreen, api, settle } = setup(tradingApi());
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
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("jupiter/swap", { vault: VAULT, sourceMint: USDC, destinationMint: MINT, amount: "500000", slippageBps: 300 });
    expect(lastScreen().text).toContain("<b>Done.</b> 1 confirmed.");
  });

  it("keeps asking after bad input and stops on /cancel", async () => {
    const { send, click, type, replies, lastScreen } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Swap");
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
    await click("💱 Swap");
    await click("SOL");
    await fill("✏️ Amount", "5");
    await click("📈 Quote & review");
    expect(alerts()).toContain("That is more than the vault holds.");
    expect(api.getQuote).not.toHaveBeenCalled();
  });

  it("expires form buttons it no longer knows", async () => {
    const { tap, replies } = setup();
    await tap("o:AAAAAAAAAAA:side");
    expect(replies.at(-1)).toBe("❌ This button expired. Send /start to begin again.");
  });
});


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

  it("runs a confirmation only once even if tapped twice", async () => {
    const ui = setup(tradingApi());
    await openSwapQuote(ui);
    await ui.click("⚡ Swap SOL → USDC");
    const confirm = ui.buttons().find((b) => b.text === "✅ Confirm & send")?.callback_data ?? "";
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
    const { send, click, buttons, tap, alerts, settle } = setup(api);
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    const claim = buttons().find((b) => b.text === "💰 Claim fees")?.callback_data ?? "";
    await click("➖ Remove liquidity");
    await click("🧺 All bins");
    const remove = buttons().find((b) => b.text === "➖ 50%")?.callback_data ?? "";
    await tap(claim);
    await click("✅ Confirm & send");
    await tap(remove);
    await tap(buttons().find((b) => b.text === "✅ Confirm & send")?.callback_data ?? "");
    expect(alerts()).toContain("Another transaction is still running. Wait for it to finish.");
    release();
    await settle();
    expect(api.build).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["💰 Claim fees", "dlmm/claim-fee", { vault: VAULT, position: "Pos1111111111111111111111111111111111111111" }],
    ["🔁 Zap out to USDC", "dlmm/zap-out", { vault: VAULT, position: "Pos1111111111111111111111111111111111111111", slippageBps: 100 }],
  ])("builds %s on a DLMM position", async (label, action, body) => {
    const { send, click, api, settle } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click(label);
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith(action, body);
  });

  it.each([
    ["🧺 All bins", {}],
    ["⬆️ Above price only · SOL", { lowerBinId: -99, upperBinId: -90 }],
    ["⬇️ Below price only · USDC", { lowerBinId: -110, upperBinId: -101 }],
  ])("removes 50%% of %s", async (preset, range) => {
    const { send, click, api, settle } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click(preset);
    await click("➖ 50%");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/remove", { vault: VAULT, position: POSITION, bpsToRemove: 5000, ...range });
  });

  it("shows a side remove's bins as prices on the confirm screen", async () => {
    const { send, click, lastScreen } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    expect(lastScreen().text).toContain("⬆️ Above price · 150.15 → 151.5068 · 10 bins · ≈ 0.4 SOL");
    await click("⬆️ Above price only · SOL");
    await click("➖ 100%");
    expect(lastScreen().text).toContain("Remove 100% of the SOL/USDC position (bins above the price)");
    expect(lastScreen().text).toContain("Bins <b>above the price</b> only · 10");
    expect(lastScreen().text).toContain("Range 150.15 → 151.5068");
  });

  it.each([
    ["⏫ Top 25% of bins", { lowerBinId: -95, upperBinId: -90 }],
    ["⏫ Top 50% of bins", { lowerBinId: -100, upperBinId: -90 }],
    ["⏬ Bottom 25% of bins", { lowerBinId: -110, upperBinId: -105 }],
    ["⏬ Bottom 50% of bins", { lowerBinId: -110, upperBinId: -100 }],
  ])("removes 25%% of %s over the whole position width", async (preset, range) => {
    const [, dlmm] = strategies;
    // Liquidity at both edges, so every quick pick holds some.
    const edges =
      dlmm?.type === "dlmm"
        ? { ...dlmm, bins: [{ binId: -110, amountX: "0", amountY: "10000000" }, ...(dlmm.bins ?? []), { binId: -90, amountX: "300000000", amountY: "0" }] }
        : dlmm;
    const { send, click, api, settle, lastScreen } = setup({ ...tradingApi(), getStrategies: vi.fn(async () => (edges ? [edges] : [])) });
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click(preset);
    await click("➖ 25%");
    expect(lastScreen().text).toContain(`(${preset.slice(2).toLowerCase()})`);
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/remove", { vault: VAULT, position: POSITION, bpsToRemove: 2500, ...range });
  });

  it("shows a quick pick's prices, bins, and token amounts", async () => {
    const { send, click, lastScreen } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    expect(lastScreen().text).toContain("⏫ Top 50% of bins · 150 → 151.5068 · 11 bins · ≈ 0.5 SOL + 25 USDC");
    await click("⏫ Top 50% of bins");
    expect(lastScreen().text).toContain("· top 50% of bins\n├ Range 150 → 151.5068\n├ Bins 11\n└ Holds ≈ 0.5 SOL + 25 USDC");
    await click("➖ 50%");
    const review = lastScreen().text;
    expect(review).toContain("Remove 50% of the SOL/USDC position (top 50% of bins)");
    expect(review).toContain("Bins <b>top 50% of bins</b> · 11");
    expect(review).toContain("Range 150 → 151.5068");
    // Floored per bin: 50% of 100000000 + 200000000 + 200000000 SOL base units, 50% of 25000000 USDC.
    expect(review).toContain("Removes ≈ 0.25 SOL + 12.5 USDC");
  });

  it("removes a typed price range, converting prices to bins", async () => {
    const { send, click, type, api, settle, lastScreen, replies } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click("✏️ Custom range");
    expect(replies.at(-1)).toContain('Send the min and max price to remove from');
    await type("149.5 150.5");
    expect(lastScreen().text).toContain("· custom range\n├ Range 149.4015 → 150.6009\n├ Bins 9\n└ Holds ≈ 0.5 SOL + 75 USDC");
    expect(lastScreen().text).not.toContain("clipped");
    await click("➖ 50%");
    expect(lastScreen().text).toContain("Removes ≈ 0.25 SOL + 37.5 USDC");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/remove", { vault: VAULT, position: POSITION, bpsToRemove: 5000, lowerBinId: -104, upperBinId: -96 });
  });

  it("clips a typed range to the position and says so", async () => {
    const { send, click, type, api, settle, lastScreen } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click("✏️ Custom range");
    await type("140, 150");
    expect(lastScreen().text).toContain("Your range was clipped to the position's bins.");
    await click("➖ 100%");
    expect(lastScreen().text).toContain("Your range was clipped to the position's bins.");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/remove", { vault: VAULT, position: POSITION, bpsToRemove: 10_000, lowerBinId: -110, upperBinId: -100 });
  });

  it("explains a bad typed range and takes a retry", async () => {
    const { send, click, type, api, settle, replies } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click("✏️ Custom range");
    await type("lots");
    expect(replies.at(-1)).toBe('Send a min and a max price, like "106.5 108.2", "106.5, 108.2", or "106.5-108.2".\nTry again, or send /cancel.');
    await type("150.5 149.5");
    expect(replies.at(-1)).toBe("The min price must be below the max price.\nTry again, or send /cancel.");
    await type("200 300");
    expect(replies.at(-1)).toBe("That range is outside this position, which covers 148.5082 → 151.5068.\nTry again, or send /cancel.");
    await type("148.6 149");
    expect(replies.at(-1)).toBe("The position holds no liquidity in that range.\nTry again, or send /cancel.");
    await type("149.5-150.5");
    await click("➖ 25%");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/remove", { vault: VAULT, position: POSITION, bpsToRemove: 2500, lowerBinId: -104, upperBinId: -96 });
  });

  it("goes back to the bin picker when a typed range is cancelled", async () => {
    const { send, click, buttons } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("➖ Remove liquidity");
    await click("✏️ Custom range");
    await click("✖️ Cancel");
    expect(buttons().map((b) => b.text)).toContain("✏️ Custom range");
  });

  it("hides a side with no liquidity and explains it", async () => {
    const [, dlmm] = strategies;
    const noX = dlmm?.type === "dlmm" ? { ...dlmm, bins: dlmm.bins?.map((b) => ({ ...b, amountX: b.binId > -100 ? "0" : b.amountX })) } : dlmm;
    const { send, click, buttons, lastScreen } = setup({ ...tradingApi(), getStrategies: vi.fn(async () => (noX ? [noX] : [])) });
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    expect(buttons().map((b) => b.text)).not.toContain("🔁 Flip SOL to Bid-Ask");
    await click("➖ Remove liquidity");
    // The fixture's bins sit mid-position, so the 25% picks at either end hold nothing and are hidden.
    expect(buttons().map((b) => b.text)).toEqual(["🧺 All bins", "⬇️ Below price only · USDC", "⏫ Top 50% of bins", "⏬ Bottom 50% of bins", "✏️ Custom range", "⬅️ Position"]);
    expect(lastScreen().text).toContain("⬆️ Above price · <i>no SOL there</i>");
  });

  it("offers only all bins and no flip when the API reports no bins", async () => {
    const [, dlmm] = strategies;
    const old = dlmm?.type === "dlmm" ? { ...dlmm, lowerBinId: undefined, upperBinId: undefined, activeBinId: undefined, binStep: undefined, bins: undefined } : dlmm;
    const { send, click, buttons, lastScreen } = setup({ ...tradingApi(), getStrategies: vi.fn(async () => (old ? [old] : [])) });
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    expect(buttons().some((b) => b.text.startsWith("🔁 Flip"))).toBe(false);
    await click("➖ Remove liquidity");
    expect(buttons().map((b) => b.text)).toEqual(["🧺 All bins", "⬅️ Position"]);
    expect(lastScreen().text).toContain("The API did not report this position's bins, so only All bins is offered.");
  });

  it("flips the non-deposit token's bins with the active bin it read", async () => {
    const { send, click, api, settle, lastScreen } = setup(tradingApi());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("🔁 Flip SOL to Bid-Ask");
    const review = lastScreen().text;
    expect(review).toContain("<b>Flip SOL to Bid-Ask in SOL/USDC LP</b>");
    expect(review).toContain("├ Token <b>SOL</b>");
    expect(review).toContain("├ Amount ≈ 0.4 SOL");
    expect(review).toContain("├ Range 150.15 → 151.5068");
    expect(review).toContain("└ Bins 10 · above the price");
    expect(review).toContain("One atomic transaction");
    expect(review).toContain("If the price moves more than 10 bins first, it fails and nothing changes.");
    expect(review).toContain("Does not claim fees.");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/flip", {
      vault: VAULT,
      position: POSITION,
      lowerBinId: -99,
      upperBinId: -90,
      activeBinId: -100,
      maxActiveBinSlippage: 10,
    });
  });

  it("flips token Y below the price when token X is the deposit token", async () => {
    const { send, click, api, settle } = setup({ ...tradingApi(), listVaults: vi.fn(async () => [{ ...vaultSummary, depositMint: SOL, depositSymbol: "SOL" }]) });
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("🔁 Flip USDC to Bid-Ask");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("dlmm/flip", expect.objectContaining({ lowerBinId: -110, upperBinId: -101, activeBinId: -100 }));
  });

  it("falls back to the side total when the API sends no per-bin amounts", async () => {
    const [, dlmm] = strategies;
    const noBins = dlmm?.type === "dlmm" ? { ...dlmm, bins: undefined } : dlmm;
    const { send, click, lastScreen } = setup({ ...tradingApi(), getStrategies: vi.fn(async () => (noBins ? [noBins] : [])) });
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("🔁 Flip SOL to Bid-Ask");
    expect(lastScreen().text).toContain("├ Amount up to 0.5 SOL");
    expect(lastScreen().text).toContain("the amount shown is the position's whole side");
  });

  it("names the dlmm/flip grant when the key lacks it", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => {
      throw new ApiError(403, "Forbidden", "Action is not enabled for this key");
    });
    const { send, click, settle, lastScreen } = setup(api);
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("🔁 Flip SOL to Bid-Ask");
    await click("✅ Confirm & send");
    await settle();
    expect(lastScreen().text).toContain('This API key may not do "dlmm/flip". Ask an admin to enable "dlmm/flip" and "send" for this key in the dashboard.');
  });

  it("offers to close an empty swap strategy", async () => {
    const { send, click, api, settle } = setup(
      { ...tradingApi(), getStrategies: vi.fn(async () => [{ type: "jupiter" as const, address: "StratJup", symbol: "BONK", decimals: 5, vaultBalance: "0" }]) }
    );
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("🗑 Close empty BONK strategy");
    await click("✅ Confirm & send");
    await settle();
    expect(api.build).toHaveBeenCalledWith("strategy/close", { vault: VAULT, strategy: "StratJup" });
  });

  it("explains a redacted Jupiter route failure in plain words", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => {
      throw new ApiError(502, "JupiterUnsupportedCpiRoute", "Service temporarily unavailable");
    });
    const ui = setup(api);
    await openSwapQuote(ui);
    await ui.click("⚡ Swap SOL → USDC");
    await ui.click("✅ Confirm & send");
    await ui.settle();
    expect(ui.lastScreen().text).toContain("<b>Failed</b> (JupiterUnsupportedCpiRoute): Service temporarily unavailable");
    expect(ui.lastScreen().text).toContain("<i>Jupiter picked a route the vault program cannot run. Try a different amount or token, or try again shortly.</i>");
    expect(ui.api.send).not.toHaveBeenCalled();
  });

  it("shows a refusal when the API builds a transaction for another payer", async () => {
    const { send, click, lastScreen, api, settle } = setup(tradingApi(), Keypair.generate());
    await send("/start");
    await click("1. Demo");
    await click("🧩 Strategies");
    await click("⚙️ SOL/USDC position");
    await click("💰 Claim fees");
    await click("✅ Confirm & send");
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
    await ui.click("➕ New LP");
  }

  it("opens a pasted pool with a custom shape, price range, and two-sided sizing", async () => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    expect(ui.api.getPool).toHaveBeenCalledWith(VAULT, POOL);
    // A pasted pool has no search result, so no fee is known.
    expect(ui.lastScreen().text).toMatch(/^🎯 <b>SOL\/USDC<\/b> · bin 10\n/);
    await ui.click("🔻 Bid-Ask");
    await ui.fill("✏️ Min price", "148");
    await ui.fill("✏️ Max price", "152");
    expect(ui.lastScreen().text).toContain("⚖️ <b>Both sides</b> · Bid-Ask · custom");
    expect(ui.lastScreen().text).toContain("<i>29 bins · holds both tokens</i>");
    await ui.click("💧 SOL amount");
    await ui.fill("✏️ Custom amount", "0.005");
    await ui.click("💧 USDC amount");
    await ui.fill("✏️ Custom amount", "50%");
    expect(ui.lastScreen().text).toContain("<b>Deposit</b>\n├ SOL 0.005\n└ USDC 0.5 (50% of balance)");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain(
      ["<b>Open SOL/USDC LP</b>", "├ Deposit 0.005 SOL + 0.5 USDC", "├ Range 147.9157 → 152.1137", "├ Bins 29 · Bid-Ask", "└ Transactions ~1"].join("\n"),
    );
    await ui.click("✅ Confirm & send");
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

  it("lists matching pools by TVL with fee and volume, and keeps only pools with the deposit token", async () => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", "sol");
    expect(ui.api.searchPools).toHaveBeenCalledWith(VAULT, "sol");
    expect(ui.lastScreen().text).toBe(
      [
        "➕ <b>New LP position</b> · pick a pool",
        '<i>Results for "sol" · paired with USDC</i>',
        "",
        "<b>1. SOL/USDC</b> · fee 0.1% · bin 10",
        "└ TVL $1.25M · Vol 24h $340K",
        "",
        "<b>2. SOL/USDC</b> · bin 80",
        "└ TVL $3.4K · Vol 24h n/a",
      ].join("\n"),
    );
    const rows = ui.lastScreen().reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text));
    expect(rows?.slice(0, 2)).toEqual([["1. SOL/USDC · 0.1%"], ["2. SOL/USDC · bin 80"]]);
    expect(ui.buttons().some((b) => b.text.includes("BONK"))).toBe(false);
    await ui.click("1. SOL/USDC · 0.1%");
    expect(ui.api.getPool).toHaveBeenCalledWith(VAULT, POOL);
    expect(ui.lastScreen().text).toMatch(/^🎯 <b>SOL\/USDC<\/b> · fee 0.1% · bin 10\n/);
  });

  it("offers only the token a one-sided range can hold and checks balances at review", async () => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    await ui.fill("✏️ Min price", "140");
    await ui.fill("✏️ Max price", "149");
    expect(ui.lastScreen().text).toContain("holds only USDC");
    // A typed range picks its side, so the side buttons follow it.
    expect(ui.buttons().map((b) => b.text)).toContain("✅ USDC only");
    expect(ui.buttons().map((b) => b.text)).not.toContain("💧 SOL amount");
    await ui.click("💧 USDC amount");
    await ui.fill("✏️ Custom amount", "2");
    await ui.click("✅ Review");
    expect(ui.alerts()).toContain("That is more than the vault holds.");
    expect(ui.api.build).not.toHaveBeenCalled();
  });

  it("switches sides with their own presets, marks the choice, and clears what a side cannot hold", async () => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    const labels = () => ui.buttons().map((b) => b.text);
    expect(labels()).toEqual(expect.arrayContaining(["✅ Both sides", "✅ Spot", "✅ ±5%", "💧 SOL amount", "💧 USDC amount"]));
    expect(ui.lastScreen().reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["💵 SOL only", "🎯 USDC only"],
      ["✅ Both sides"],
      ["✅ Spot", "⛰ Curve", "🔻 Bid-Ask"],
      ["±1%", "±2%", "✅ ±5%"],
      ["±10%", "±20%"],
      ["✏️ Min price", "✏️ Max price"],
      ["💧 SOL amount", "💧 USDC amount"],
      ["🫙 Empty position only"],
      ["🏊 Change pool", "⬅️ Vault"],
    ]);
    await ui.click("💧 USDC amount");
    await ui.fill("✏️ Custom amount", "50%");

    await ui.click("💵 SOL only");
    expect(ui.lastScreen().text).toContain("💵 <b>SOL only</b> · sell as price rises · Spot · +10%");
    expect(ui.lastScreen().text).toContain("holds only SOL");
    expect(ui.lastScreen().text).toContain("<b>Deposit</b>\n└ SOL <i>not set</i>");
    expect(labels()).toEqual(expect.arrayContaining(["✅ SOL only", "⚖️ Both sides", "✅ +10%", "+90%", "💧 SOL amount"]));
    expect(labels()).not.toContain("💧 USDC amount");

    await ui.click("⚖️ Both sides");
    expect(ui.lastScreen().text).toContain("└ USDC <i>not set</i>");

    await ui.click("🎯 USDC only");
    expect(ui.lastScreen().text).toContain("🎯 <b>USDC only</b> · buy SOL as price falls · Spot · −10%");
    expect(ui.lastScreen().text).toContain("holds only USDC");
    expect(labels()).not.toContain("💧 SOL amount");
    await ui.click("−20%");
    expect(labels()).toContain("✅ −20%");
    expect(labels()).not.toContain("✅ −10%");

    await ui.fill("✏️ Min price", "120");
    expect(ui.lastScreen().text).toContain("· Spot · custom");
    expect(labels().filter((label) => /%.*✅$/.test(label))).toEqual([]);
  });

  it.each([
    ["💵 SOL only", "💧 SOL amount", { lowerBinId: -99, amountX: "10000000", amountY: "0" }],
    ["🎯 USDC only", "💧 USDC amount", { upperBinId: -100, amountX: "0", amountY: "1000000" }],
  ])("opens %s on the bins next to the price", async (side, amountButton, expected) => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    await ui.click(side);
    await ui.click(amountButton);
    await ui.click("100%");
    await ui.click("✅ Review");
    await ui.click("✅ Confirm & send");
    await ui.settle();
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/open", expect.objectContaining(expected));
  });

  it("sizes 100% from the vault's idle balance, not holdings that include LP positions", async () => {
    // Holdings count 2.05 USDC sitting in an LP position on top of the 1 USDC idle in the vault.
    const withLp = { ...holdings, tokens: holdings.tokens.map((t) => (t.token.mint === USDC ? { ...t, amount: "3050000" } : t)) };
    const ui = setup({ ...tradingApi(), getHoldings: vi.fn(async () => withLp) });
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    await ui.click("🎯 USDC only");
    await ui.click("💧 USDC amount");
    expect(ui.lastScreen().text).toContain("Idle in vault <b>1 USDC</b>");
    await ui.click("100%");
    await ui.click("✅ Review");
    await ui.click("✅ Confirm & send");
    await ui.settle();
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/open", expect.objectContaining({ amountX: "0", amountY: "1000000" }));
  });

  it("picks an amount as a share of the vault balance, marks it, and goes back without changes", async () => {
    const ui = setup(tradingApi());
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    await ui.click("💧 USDC amount");
    expect(ui.lastScreen().text).toBe(
      ["💧 <b>How much USDC?</b>", "━━━━━━━━━━━━", "Idle in vault <b>1 USDC</b>", "Now <i>not set</i>", "", "<i>Tap a share of the balance, or ✏️ Custom amount to type one.</i>"].join("\n"),
    );
    const rows = () => ui.lastScreen().reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text));
    expect(rows()).toEqual([["25%", "50%", "75%", "100%"], ["✏️ Custom amount"], ["⬅️ Back"]]);
    await ui.click("75%");
    expect(ui.lastScreen().text).toContain("└ USDC 0.75 (75% of balance)");
    await ui.click("💧 USDC amount");
    expect(rows()?.[0]).toEqual(["25%", "50%", "✅ 75%", "100%"]);
    await ui.click("⬅️ Back");
    expect(ui.lastScreen().text).toContain("└ USDC 0.75 (75% of balance)");
  });

  it("rejects a pasted pool that does not include the deposit token", async () => {
    const ui = setup({ ...tradingApi(), getPool: vi.fn(async () => ({ ...pool, tokenY: { mint: "Bonk111111111111111111111111111111111111111", symbol: "BONK", decimals: 5 } })) });
    await newPosition(ui);
    await ui.fill("🏊 Pick pool", POOL);
    expect(ui.replies.at(-1)).toBe("That pool does not include the vault's deposit token, USDC.\nTry again, or send /cancel.");
  });

  it("adds liquidity to an existing position with its own shape and sizing", async () => {
    const ui = setup({ ...tradingApi(), getStrategies: vi.fn(async () => strategies.map((s) => (s.type === "dlmm" ? { ...s, lbPair: POOL } : s))) });
    await ui.send("/start");
    await ui.click("1. Demo");
    await ui.click("🧩 Strategies");
    await ui.click("⚙️ SOL/USDC position");
    await ui.click("➕ Add liquidity");
    expect(ui.lastScreen().text).toMatch(/^➕ <b>SOL\/USDC<\/b> · add liquidity · bin 10/);
    expect(ui.buttons().map((b) => b.text)).not.toContain("✏️ Min price");
    expect(ui.buttons().map((b) => b.text)).not.toContain("✅ Both sides");
    await ui.click("⛰ Curve");
    await ui.click("💧 USDC amount");
    await ui.fill("✏️ Custom amount", "max");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("<b>Add to SOL/USDC LP</b>\n├ Deposit 1 USDC\n└ Shape Curve");
    await ui.click("✅ Confirm & send");
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

describe("wallets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const deleted = (calls: { method: string; payload: unknown }[]) =>
    calls.filter((c) => c.method === "deleteMessage").map((c) => (c.payload as { message_id: number }).message_id);

  it("sends a new user to the wallet menu instead of the vaults", async () => {
    const { api, send, lastScreen, buttons } = setup({}, null);
    await send("/start");
    expect(lastScreen().text).toContain("Add the wallet that manages your vault to start.");
    expect(buttons().map((b) => b.text)).toEqual(["📥 Import wallet", "✨ New wallet", "🔀 My wallets · switch"]);
    expect(api.listVaults).not.toHaveBeenCalled();
  });

  it("imports a pasted private key, deleting the message, then checks and stores an API key", async () => {
    const { api, wallets, send, click, type, lastScreen, calls, buttons } = setup({}, null);
    const imported = Keypair.generate();
    await send("/wallet");
    await click("📥 Import wallet");
    await type(bs58.encode(imported.secretKey));
    expect(deleted(calls)).toContain(50);
    expect(lastScreen().text).toContain("📥 <b>Wallet imported.</b>");
    expect(lastScreen().text).toContain(imported.publicKey.toBase58());
    expect(lastScreen().text).toContain("No API key yet.");

    await click("🔐 Add API key");
    await type("not an api key");
    expect(lastScreen().text).toBe("An API key looks like hv1_<id>_<secret>.\nPaste it again, or send /cancel.");
    await type(API_KEY);
    expect(api.listVaults).toHaveBeenCalledTimes(1);
    expect(deleted(calls).filter((id) => id === 50)).toHaveLength(3);
    expect(lastScreen().text).toContain("🔐 <b>API key saved.</b>");
    expect(buttons().map((b) => b.text)).toContain("🏦 Vaults");
    const active = wallets.active(ALLOWED_USER);
    expect(active && wallets.apiKey(ALLOWED_USER, active.id)).toBe(API_KEY);
  });

  it("does not store an API key the API rejects", async () => {
    const { wallets, send, click, type, lastScreen } = setup(
      { listVaults: vi.fn(async () => Promise.reject(new ApiError(401, "Unauthorized", "Invalid API key"))) },
      null,
    );
    await send("/wallet");
    await click("✨ New wallet");
    await click("🔐 Add API key");
    await type(API_KEY);
    expect(lastScreen().text).toBe("The API rejected that key: it is wrong, revoked, or expired.\nPaste it again, or send /cancel.");
    expect(wallets.active(ALLOWED_USER)?.hasApiKey).toBe(false);
  });

  it("generates a wallet and reveals its key once, protected and deleted after a minute", async () => {
    vi.useFakeTimers();
    const { wallets, send, click, calls, lastScreen } = setup({}, null);
    await send("/wallet");
    await click("✨ New wallet");
    const active = wallets.active(ALLOWED_USER);
    if (!active) throw new Error("no active wallet");
    expect(active.origin).toBe("generated");
    expect(lastScreen().text).toContain("✨ <b>New wallet created.</b>");

    await click("🔑 Export private key");
    await click("👁 Show private key");
    const secret = bs58.encode(wallets.keypair(ALLOWED_USER, active.id).secretKey);
    const reveal = calls.find((c) => c.method === "sendMessage" && c.payload.text.includes(secret));
    expect(reveal?.payload).toMatchObject({ protect_content: true, parse_mode: "HTML" });
    expect(reveal?.payload.text).toContain(`<tg-spoiler><code>${secret}</code></tg-spoiler>`);
    const revealId = 100 + calls.filter((c) => c.method === "sendMessage").indexOf(reveal as (typeof calls)[number]);
    expect(deleted(calls)).not.toContain(revealId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deleted(calls)).toContain(revealId);
  });

  it("switches the active wallet and expires buttons made for the previous one", async () => {
    const { wallets, send, click, tap, buttons, lastScreen, replies } = setup();
    await send("/start");
    await click("1. Demo");
    await click("💱 Swap");
    const formButton = buttons()[0]?.callback_data ?? "";
    const second = wallets.add(ALLOWED_USER, Keypair.generate(), "generated").wallet;
    wallets.setApiKey(ALLOWED_USER, second.id, API_KEY);
    const first = wallets.list(ALLOWED_USER)[0];
    if (!first) throw new Error("no first wallet");
    wallets.use(ALLOWED_USER, first.id);

    await send("/wallet");
    await click("🔀 My wallets · switch");
    expect(buttons().map((b) => b.text)).toEqual([
      `✅ ${manager.publicKey.toBase58().slice(0, 4)}…${manager.publicKey.toBase58().slice(-4)} · imported`,
      "🗑",
      `${second.publicKey.slice(0, 4)}…${second.publicKey.slice(-4)} · generated`,
      "🗑",
      "👛 Wallet",
    ]);
    await tap(buttons()[2]?.callback_data ?? "");
    expect(lastScreen().text).toContain(`✅ Active wallet is now <code>${second.publicKey}</code>.`);
    await tap(formButton);
    expect(replies.at(-1)).toBe("❌ This button expired. Send /start to begin again.");
  });

  it("acts with a replaced API key from the next screen on", async () => {
    const replacement = `hv1_next_${"b".repeat(64)}`;
    const { send, click, type, listedWith } = setup();
    await send("/start");
    await send("/wallet");
    await click("🔐 Replace API key");
    await type(replacement);
    await send("/vaults");
    expect(listedWith).toEqual([API_KEY, replacement, replacement]);
  });

  it("removes a wallet only after confirmation", async () => {
    const { wallets, send, click, buttons } = setup();
    await send("/wallet");
    await click("🔀 My wallets · switch");
    await click("🗑");
    expect(wallets.list(ALLOWED_USER)).toHaveLength(1);
    await click("✖️ Keep it");
    await click("🗑");
    await click("🗑 Yes, remove it");
    expect(wallets.list(ALLOWED_USER)).toEqual([]);
    expect(buttons().map((b) => b.text)).toEqual(["👛 Wallet"]);
  });

  it("deletes a private key pasted outside the import prompt", async () => {
    const { wallets, type, calls, replies } = setup({}, null);
    await type(bs58.encode(Keypair.generate().secretKey));
    expect(deleted(calls)).toEqual([50]);
    expect(replies.at(-1)).toBe("That looked like a private key, so the bot deleted it. To add a wallet, use /wallet → 📥 Import wallet.");
    expect(wallets.list(ALLOWED_USER)).toEqual([]);
  });

  it("ignores group chats, where others could read a pasted key", async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 51,
        date: 0,
        chat: { id: -100, type: "group", title: "G" },
        from: { id: ALLOWED_USER, is_bot: false, first_name: "T" },
        text: "/wallet",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    });
    expect(replies).toEqual([]);
  });
});

const POSITION = "Pos1111111111111111111111111111111111111111";
const NEW_VAULT = "NewVau1t11111111111111111111111111111111111";
const NEW_POSITION = "NewPos11111111111111111111111111111111111111";

async function openVault(ui: ReturnType<typeof setup>, label?: string) {
  await ui.send("/start");
  await ui.click("1. Demo");
  if (label) await ui.click(label);
}

/** Confirms the open confirm screen and waits for the action to finish. */
async function confirm(ui: ReturnType<typeof setup>) {
  await ui.click("✅ Confirm & send");
  await ui.settle();
}

describe("vault reads", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["/nav 1", "📊 <b>Demo</b> · NAV history"],
    ["/requests 1", "📋 <b>Demo</b> · queued requests"],
    ["/history 1", "🗂 <b>Demo</b> · closed strategies"],
    ["/phoenix 1", "📈 <b>Demo</b> · Phoenix perps"],
    ["/settings 1", "⚙️ <b>Demo</b> · settings"],
  ])("answers %s", async (command, title) => {
    const { send, replies } = setup();
    await send(command);
    expect(replies.at(-1)?.split("\n")[0]).toBe(title);
  });

  it("still opens the vault menu when holdings and strategies cannot be read", async () => {
    const failing = vi.fn(async () => {
      throw new Error("valuation down");
    });
    const ui = setup({ getHoldings: failing, getStrategies: failing });
    await openVault(ui);
    expect(ui.lastScreen().text).toContain("TVL <b>1.5 USDC</b>\n<i>⚠️ Live holdings unavailable right now. Tap 🔄 Refresh.</i>");
    expect(ui.buttons().map((b) => b.text)).toContain("⚙️ Settings");
  });

  it("asks for the last 10 NAVs from the vault screen", async () => {
    const ui = setup();
    await openVault(ui, "📊 NAV history");
    expect(ui.api.getNavHistory).toHaveBeenCalledWith(VAULT, 10);
    expect(ui.buttons().map((b) => b.text)).toEqual(["🔄 Refresh", "⬅️ Back", "🏦 Vaults"]);
  });

  it("explains a server without history in plain words", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, replies } = setup({ getNavHistory: vi.fn(async () => Promise.reject(new ApiError(503, "HistoryUnavailable", "Service temporarily unavailable"))) });
    await send("/nav 1");
    expect(replies.at(-1)).toBe(
      "❌ <b>API error 503 (HistoryUnavailable)</b>\nService temporarily unavailable\nThis server keeps no history database, so history is not available.",
    );
  });

  it("names the read scope when the key lacks it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, replies } = setup({ getRequests: vi.fn(async () => Promise.reject(new ApiError(403, "Forbidden", "Action is not enabled for this key"))) });
    await send("/requests 1");
    expect(replies.at(-1)).toBe(
      '❌ <b>API error 403 (Forbidden)</b>\nAction is not enabled for this key\nThis API key may not do "read". Ask an admin to enable "read" for this key in the dashboard.',
    );
  });
});

describe("phoenix", () => {
  afterEach(() => vi.restoreAllMocks());

  const actionButtons = (ui: ReturnType<typeof setup>) => ui.buttons().map((b) => b.text).filter((t) => t !== "🔄 Refresh" && t !== "⬅️ Back");

  it.each([
    ["no strategy", phoenixNone, ["🚀 Set up Phoenix"]],
    ["not onboarded", phoenixRegistered, ["🤝 Onboard trader"]],
    ["ready", phoenixReady, ["💵 Deposit USDC", "📤 Withdraw", "🆕 New order", "🧹 Sweep", "✖️ Cancel all SOL orders"]],
    ["not a USDC vault", { ...phoenixNone, usdcVault: false }, []],
  ] as const)("shows only the next step when %s", async (_, phoenix, expected) => {
    const ui = setup({ getPhoenix: vi.fn(async () => phoenix) });
    await openVault(ui, "📈 Phoenix");
    expect(actionButtons(ui)).toEqual(expected);
  });

  it("sets up the strategy, then onboards the trader through onboardPhoenix", async () => {
    const onboardPhoenix = vi.fn(async () => ({ kind: "confirmed" as const, signatures: ["OnboardSig"] }));
    const ui = setup({ ...tradingApi(), getPhoenix: vi.fn(async () => phoenixNone), onboardPhoenix });
    await openVault(ui, "📈 Phoenix");
    await ui.click("🚀 Set up Phoenix");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("phoenix/initialize", { vault: VAULT });

    vi.mocked(ui.api.getPhoenix).mockResolvedValue(phoenixRegistered);
    await openVault(ui, "📈 Phoenix");
    await ui.click("🤝 Onboard trader");
    expect(ui.lastScreen().text).toContain("<b>Onboard the vault's Phoenix trader</b>");
    await confirm(ui);
    expect(onboardPhoenix).toHaveBeenCalledWith(VAULT, expect.objectContaining({ publicKey: manager.publicKey }), expect.anything());
    expect(ui.lastScreen().text).toContain("<b>Done.</b> 1 confirmed.");
  });

  it("explains an already onboarded trader", async () => {
    const onboardPhoenix = vi.fn(async () => ({
      kind: "failed" as const,
      signatures: [],
      code: "PhoenixAlreadyOnboarded",
      message: "The vault's Phoenix trader is already onboarded",
    }));
    const ui = setup({ getPhoenix: vi.fn(async () => phoenixRegistered), onboardPhoenix });
    await openVault(ui, "📈 Phoenix");
    await ui.click("🤝 Onboard trader");
    await confirm(ui);
    expect(ui.lastScreen().text).toContain("<i>The vault's Phoenix trader is already onboarded. Open 📈 Phoenix again to deposit and trade.</i>");
  });

  it("deposits a share of idle USDC and withdraws everything withdrawable", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "📈 Phoenix");
    await ui.click("💵 Deposit USDC");
    await ui.click("50%");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("<b>Deposit 0.5 USDC into Phoenix</b>");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("phoenix/deposit", { vault: VAULT, amount: "500000" });

    await openVault(ui, "📈 Phoenix");
    await ui.click("📤 Withdraw");
    await ui.click("Max");
    await ui.click("✅ Review");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("phoenix/withdraw", { vault: VAULT, amount: "4000000" });
  });

  it("places a short market order with custom slippage", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "📈 Phoenix");
    await ui.click("🆕 New order");
    await ui.click("SOL");
    await ui.click("🟢 Long · tap for short");
    await ui.fill("✏️ Size", "0.5");
    await ui.fill("✏️ Slippage", "5");
    expect(ui.lastScreen().text).toContain("Market order · slippage 5%");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("<b>Short 0.5 SOL at market</b>");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("phoenix/order", {
      vault: VAULT,
      symbol: "SOL",
      side: "short",
      size: "0.5",
      reduceOnly: false,
      order: { type: "market", slippageBps: 500 },
    });
  });

  it("places a post-only, reduce-only limit order on a typed market", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "📈 Phoenix");
    await ui.click("🆕 New order");
    await ui.fill("✏️ Market", "btc");
    await ui.fill("✏️ Size", "0.01");
    await ui.click("⚡ Market order · tap for limit");
    expect(ui.buttons().map((b) => b.text)).not.toContain("✅ Review");
    await ui.fill("✏️ Limit price", "65,000.5");
    await ui.click("Post-only: off");
    await ui.click("↩️ Reduce-only: off");
    await ui.click("✅ Review");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("phoenix/order", {
      vault: VAULT,
      symbol: "BTC",
      side: "long",
      size: "0.01",
      reduceOnly: true,
      order: { type: "limit", price: "65000.5", postOnly: true },
    });
  });

  it("cancels every order on one market and sweeps", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "📈 Phoenix");
    await ui.click("✖️ Cancel all SOL orders");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("phoenix/cancel", { vault: VAULT, symbol: "SOL", orders: "all" });
    await openVault(ui, "📈 Phoenix");
    await ui.click("🧹 Sweep");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("phoenix/sweep", { vault: VAULT });
  });

  it("tells the user which scope the admin must grant", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => Promise.reject(new ApiError(403, "Forbidden", "Action is not enabled for this key")));
    const ui = setup(api);
    await openVault(ui, "📈 Phoenix");
    await ui.click("🧹 Sweep");
    await confirm(ui);
    expect(ui.lastScreen().text).toContain(
      '<i>This API key may not do "phoenix/sweep". Ask an admin to enable "phoenix/sweep" and "send" for this key in the dashboard.</i>',
    );
  });
});

describe("vault settings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers toggles and the statuses the vault is not in", async () => {
    const ui = setup();
    await openVault(ui, "⚙️ Settings");
    expect(ui.buttons().map((b) => b.text)).toEqual([
      "⏸ Pause deposits",
      "▶️ Resume withdrawals",
      "🟡 Reduce-only",
      "🔴 Paused",
      "✏️ Edit fees and limits",
      "💰 Claim manager fee",
      "🗑 Close vault",
      "🔄 Refresh",
      "⬅️ Back",
    ]);
  });

  it.each([
    ["⏸ Pause deposits", { vault: VAULT, depositPaused: true }],
    ["▶️ Resume withdrawals", { vault: VAULT, withdrawalPaused: false }],
    ["🟡 Reduce-only", { vault: VAULT, status: "reduceOnly" }],
  ])("%s sends one vault/update with only that field", async (label, body) => {
    const ui = setup(tradingApi());
    await openVault(ui, "⚙️ Settings");
    await ui.click(label);
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("vault/update", body);
  });

  it("warns in plain words before pausing the vault", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "⚙️ Settings");
    await ui.click("🔴 Paused");
    expect(ui.lastScreen().text).toContain("Status → <b>Paused</b>");
    expect(ui.lastScreen().text).toContain(
      "<blockquote>⚠️ Paused stops depositors from withdrawing, and blocks deposits and trading, until you set the vault back to Normal.</blockquote>",
    );
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("vault/update", { vault: VAULT, status: "paused" });
  });

  it("edits fees and limits and sends only the changed fields", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "⚙️ Settings");
    await ui.click("✏️ Edit fees and limits");
    expect(ui.buttons().map((b) => b.text)).not.toContain("✅ Review");
    await ui.fill("✏️ Performance fee", "12.5%");
    await ui.fill("✏️ Management fee", "2");
    await ui.fill("✏️ Deposit cap", "none");
    expect(ui.lastScreen().text).toContain("Performance fee → <b>12.5%</b>");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("Deposit cap → <b>no cap</b>");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("vault/update", { vault: VAULT, performanceFeeBps: 1250, depositCap: "18446744073709551615" });
  });

  it("claims the manager fee and closes the vault after a warning", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "⚙️ Settings");
    await ui.click("💰 Claim manager fee");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("vault/claim-fee", { vault: VAULT });
    await openVault(ui, "⚙️ Settings");
    await ui.click("🗑 Close vault");
    expect(ui.lastScreen().text).toContain("⚠️ Closing deletes this vault for good.");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenLastCalledWith("vault/close", { vault: VAULT });
  });
});

describe("create vault", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a USDC vault and links the new address", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => [{ ...builtStep(), vault: NEW_VAULT }]);
    const ui = setup(api);
    await ui.send("/start");
    await ui.click("✨ Create vault");
    expect(ui.lastScreen().text).toContain("Deposit token <b>USDC</b>");
    await ui.fill("✏️ Name", "Alpha 🚀");
    await ui.fill("✏️ Performance fee", "10");
    await ui.fill("✏️ Deposit cap", "50,000");
    await ui.fill("✏️ Min deposit", "5");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain('<b>Create the vault "Alpha 🚀"</b>');
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("vault/initialize", {
      name: "Alpha 🚀",
      depositMint: USDC,
      performanceFeeBps: 1000,
      managementFeeBps: 0,
      depositCap: "50000000000",
      minDeposit: "5000000",
      minWithdrawalShares: "1000000",
    });
    expect(ui.lastScreen().text).toContain(`New vault <code>${NEW_VAULT}</code>`);
    expect(ui.buttons().find((b) => b.text === "🏦 Open new vault")?.callback_data).toBe(`v:${NEW_VAULT}`);
  });

  it("looks up a pasted deposit mint through a managed vault", async () => {
    const MINT = "PastedMint111111111111111111111111111111111";
    const ui = setup();
    await ui.send("/start");
    await ui.click("✨ Create vault");
    await ui.fill("📋 Paste deposit mint", MINT);
    expect(ui.api.getToken).toHaveBeenCalledWith(VAULT, MINT);
    expect(ui.lastScreen().text).toContain(`Deposit token <b>PASTED</b> <code>${MINT}</code>`);
  });

  it("explains a vault-restricted key", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => Promise.reject(new ApiError(403, "Forbidden", "Vault creation requires a key without a vault restriction")));
    const ui = setup(api);
    await ui.send("/start");
    await ui.click("✨ Create vault");
    await ui.fill("✏️ Name", "Beta");
    await ui.click("✅ Review");
    await confirm(ui);
    expect(ui.lastScreen().text).toContain(
      '<i>Creating a vault needs an API key that is not limited to specific vaults. Ask an admin for one with "vault/initialize" and "send".</i>',
    );
    expect(ui.buttons().map((b) => b.text)).toEqual(["🏦 Vaults"]);
  });
});

describe("strategy setup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tracks a pasted token after showing it is unverified", async () => {
    const MINT = "PastedMint111111111111111111111111111111111";
    const ui = setup(tradingApi());
    await openVault(ui, "🧩 Strategies");
    await ui.click("➕ Track token");
    await ui.fill("📋 Paste CA", MINT);
    expect(ui.lastScreen().text).toContain("⚠️ <i>Not verified by Jupiter. Double-check the address.</i>");
    await ui.click("✅ Review");
    expect(ui.lastScreen().text).toContain("Jupiter has not verified this token");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("jupiter/initialize", { vault: VAULT, targetMint: MINT });
  });

  it("closes a DLMM position after a warning", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "🧩 Strategies");
    await ui.click("⚙️ SOL/USDC position");
    await ui.click("🗑 Close position");
    expect(ui.lastScreen().text).toContain("removes all of the position's liquidity, claims its fees");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/close", { vault: VAULT, position: POSITION });
  });

  it("creates an empty position over the chosen range and shows its address", async () => {
    const api = tradingApi();
    api.build = vi.fn(async () => [{ ...builtStep(), position: NEW_POSITION }]);
    const ui = setup(api);
    await openVault(ui, "➕ New LP");
    await ui.fill("🏊 Pick pool", POOL);
    await ui.fill("✏️ Min price", "148");
    await ui.fill("✏️ Max price", "152");
    await ui.click("🫙 Empty position only");
    expect(ui.lastScreen().text).toContain("<b>Create an empty SOL/USDC position</b>");
    await confirm(ui);
    expect(ui.api.build).toHaveBeenCalledWith("dlmm/initialize", { vault: VAULT, lbPair: POOL, lowerBinId: -114, upperBinId: -85 });
    expect(ui.lastScreen().text).toContain(`New position <code>${NEW_POSITION}</code>`);
  });

  it("refuses an empty position wider than 70 bins", async () => {
    const ui = setup(tradingApi());
    await openVault(ui, "➕ New LP");
    await ui.fill("🏊 Pick pool", POOL);
    await ui.click("±10%");
    await ui.click("🫙 Empty position only");
    expect(ui.alerts().at(-1)).toMatch(/^An empty position can span at most 70 bins; this range has \d+\. Narrow it\.$/);
    expect(ui.api.build).not.toHaveBeenCalled();
  });
});
