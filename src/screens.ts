import { randomBytes } from "node:crypto";
import { Markup } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { HedgeApi, VaultSummary } from "./api";
import {
  holdingsMessage,
  quoteAmountMessage,
  quotePickMessage,
  quoteResultMessage,
  strategiesMessage,
  vaultMessage,
  vaultsMessage,
} from "./messages";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const AMOUNT_PERCENTS = [10, 25, 50, 100] as const;
export type AmountPercent = (typeof AMOUNT_PERCENTS)[number];

export interface TokenRef {
  mint: string;
  symbol: string;
  decimals: number;
}

/** A swap direction the user picked, with the vault's input-token balance when it was picked. */
export interface QuotePair {
  vault: string;
  input: TokenRef;
  output: TokenRef;
  inputBalanceBaseUnits: string;
}

export type Screen =
  | { kind: "vaults" }
  | { kind: "vault"; vault: string }
  | { kind: "holdings"; vault: string }
  | { kind: "strategies"; vault: string }
  | { kind: "quotePick"; vault: string }
  | { kind: "quoteAmount"; pairId: string }
  | { kind: "quote"; pairId: string; percent: AmountPercent };

/**
 * Telegram caps callback data at 64 bytes, too small for a vault plus two mints. Quote pairs live
 * here and buttons carry a random id, so a button from before a restart can never point at a
 * different pair.
 * ponytail: in-memory and per process; buttons expire on restart. Move to Redis if the bot runs replicas.
 */
export function createPairStore(limit = 1000) {
  const pairs = new Map<string, QuotePair>();
  return {
    put(pair: QuotePair): string {
      const id = randomBytes(8).toString("base64url");
      pairs.set(id, pair);
      if (pairs.size > limit) {
        const oldest = pairs.keys().next().value;
        if (oldest !== undefined) pairs.delete(oldest);
      }
      return id;
    },
    get: (id: string): QuotePair | undefined => pairs.get(id),
  };
}
export type PairStore = ReturnType<typeof createPairStore>;

const ADDRESS = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const PAIR_ID = "([A-Za-z0-9_-]{11})";

export function encodeScreen(screen: Screen): string {
  switch (screen.kind) {
    case "vaults":
      return "vaults";
    case "vault":
      return `v:${screen.vault}`;
    case "holdings":
      return `h:${screen.vault}`;
    case "strategies":
      return `s:${screen.vault}`;
    case "quotePick":
      return `qp:${screen.vault}`;
    case "quoteAmount":
      return `qa:${screen.pairId}`;
    case "quote":
      return `qq:${screen.pairId}:${screen.percent}`;
  }
}

/** Callback data arrives from the client, so anything unexpected decodes to undefined. */
export function decodeScreen(data: string): Screen | undefined {
  if (data === "vaults") return { kind: "vaults" };
  const vaultScreen = new RegExp(`^(v|h|s|qp):${ADDRESS}$`).exec(data);
  if (vaultScreen) {
    const vault = vaultScreen[2] as string;
    const kind = ({ v: "vault", h: "holdings", s: "strategies", qp: "quotePick" } as const)[vaultScreen[1] as "v" | "h" | "s" | "qp"];
    return { kind, vault };
  }
  const amount = new RegExp(`^qa:${PAIR_ID}$`).exec(data);
  if (amount) return { kind: "quoteAmount", pairId: amount[1] as string };
  const quote = new RegExp(`^qq:${PAIR_ID}:(\\d{1,3})$`).exec(data);
  const percent = Number(quote?.[2]);
  if (quote && (AMOUNT_PERCENTS as readonly number[]).includes(percent)) {
    return { kind: "quote", pairId: quote[1] as string, percent: percent as AmountPercent };
  }
  return undefined;
}

export interface RenderedScreen {
  html: string;
  keyboard: InlineKeyboardMarkup;
}

/** A button that can no longer be served; shown to the user as-is. */
export class ScreenNotice extends Error {}
const expired = () => new ScreenNotice("This button expired. Send /start to begin again.");

const button = (text: string, screen: Screen) => Markup.button.callback(text, encodeScreen(screen));
const keyboard = (rows: ReturnType<typeof button>[][]) => Markup.inlineKeyboard(rows).reply_markup;
const homeButton = button("🏦 Vaults", { kind: "vaults" });

async function findVault(api: HedgeApi, address: string): Promise<VaultSummary> {
  const vault = (await api.listVaults()).find((v) => v.address === address);
  if (!vault) throw new ScreenNotice("That vault is no longer in this API key's scope.");
  return vault;
}

export function percentOf(baseUnits: string, percent: AmountPercent): string {
  return ((BigInt(baseUnits) * BigInt(percent)) / 100n).toString();
}

export async function renderScreen(screen: Screen, deps: { api: HedgeApi; pairs: PairStore }): Promise<RenderedScreen> {
  const { api, pairs } = deps;
  switch (screen.kind) {
    case "vaults": {
      const vaults = await api.listVaults();
      return {
        html: vaultsMessage(vaults),
        keyboard: keyboard([
          ...vaults.map((vault, index) => [button(`${index + 1}. ${vault.name}`, { kind: "vault", vault: vault.address })]),
          [button("🔄 Refresh", screen)],
        ]),
      };
    }
    case "vault": {
      const vault = await findVault(api, screen.vault);
      return {
        html: vaultMessage(vault),
        keyboard: keyboard([
          [button("📊 Holdings", { kind: "holdings", vault: vault.address }), button("🧩 Strategies", { kind: "strategies", vault: vault.address })],
          [button("💱 Quote a swap", { kind: "quotePick", vault: vault.address })],
          [homeButton],
        ]),
      };
    }
    case "holdings":
    case "strategies": {
      const vault = await findVault(api, screen.vault);
      const html =
        screen.kind === "holdings"
          ? holdingsMessage(vault, await api.getHoldings(vault.address))
          : strategiesMessage(vault, await api.getStrategies(vault.address));
      return {
        html,
        keyboard: keyboard([[button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton]]),
      };
    }
    case "quotePick": {
      const vault = await findVault(api, screen.vault);
      const holdings = await api.getHoldings(vault.address);
      const deposit = holdings.depositToken;
      const depositBalance = holdings.tokens.find((t) => t.token.mint === deposit.mint)?.amount ?? "0";
      const others = holdings.tokens.filter((t) => t.token.mint !== deposit.mint);
      const rows = others.map((held) => {
        const sell: QuotePair = { vault: vault.address, input: held.token, output: deposit, inputBalanceBaseUnits: held.amount };
        const buy: QuotePair = { vault: vault.address, input: deposit, output: held.token, inputBalanceBaseUnits: depositBalance };
        return [
          button(`Sell ${held.token.symbol}`, { kind: "quoteAmount", pairId: pairs.put(sell) }),
          button(`Buy ${held.token.symbol}`, { kind: "quoteAmount", pairId: pairs.put(buy) }),
        ];
      });
      return {
        html: quotePickMessage(vault, deposit.symbol, others.length),
        keyboard: keyboard([...rows, [button("⬅️ Back", { kind: "vault", vault: vault.address })]]),
      };
    }
    case "quoteAmount": {
      const pair = pairs.get(screen.pairId);
      if (!pair) throw expired();
      const amounts = AMOUNT_PERCENTS.map((percent) => button(`${percent}%`, { kind: "quote", pairId: screen.pairId, percent }));
      return {
        html: quoteAmountMessage(pair),
        keyboard: keyboard([amounts, [button("⬅️ Back", { kind: "quotePick", vault: pair.vault })]]),
      };
    }
    case "quote": {
      const pair = pairs.get(screen.pairId);
      if (!pair) throw expired();
      const amountBaseUnits = percentOf(pair.inputBalanceBaseUnits, screen.percent);
      const back = keyboard([
        [button("🔄 Refresh", screen), button("⬅️ Amount", { kind: "quoteAmount", pairId: screen.pairId })],
        [button("🏦 Vaults", { kind: "vaults" })],
      ]);
      if (amountBaseUnits === "0") return { html: quoteResultMessage(pair, screen.percent, undefined), keyboard: back };
      const quote = await api.getQuote({
        vault: pair.vault,
        inputMint: pair.input.mint,
        outputMint: pair.output.mint,
        amountBaseUnits,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      return { html: quoteResultMessage(pair, screen.percent, quote), keyboard: back };
    }
  }
}
