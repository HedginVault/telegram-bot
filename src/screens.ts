import { randomBytes } from "node:crypto";
import { Markup } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import { type LiquidityAmounts, type PendingAction, REMOVE_BPS, type RemoveBps } from "./actions";
import { LP_WIDTHS, type LpWidth, rangePrices, rangeSpanPct, singleSidedRange } from "./lp";
import type { HedgeClient, Strategy, VaultSummary } from "@hedginvault/sdk";
import {
  confirmMessage,
  holdingsMessage,
  lpAmountMessage,
  lpPoolsMessage,
  lpRangeMessage,
  positionMessage,
  quoteAmountMessage,
  quotePickMessage,
  quoteResultMessage,
  strategiesMessage,
  vaultMessage,
  vaultsMessage,
} from "./messages";

export const DEFAULT_SLIPPAGE_BPS = 50;
// The protocol config caps swaps at 300 bps.
export const SLIPPAGE_OPTIONS = [50, 100, 300] as const;
export type SlippageBps = (typeof SLIPPAGE_OPTIONS)[number];
export const AMOUNT_PERCENTS = [10, 25, 50, 100] as const;
const ADD_PERCENTS = [25, 50, 100] as const;
export type AmountPercent = (typeof AMOUNT_PERCENTS)[number];

export interface TokenRef {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface PositionRef {
  vault: string;
  position: string;
}

/** A new position being set up: pool first, then width. */
export interface LpDraft {
  vault: string;
  lbPair: string;
  width?: LpWidth;
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
  | { kind: "quote"; pairId: string; percent: AmountPercent; slippageBps: SlippageBps }
  | { kind: "lpPools"; vault: string }
  | { kind: "lpRange"; draftId: string }
  | { kind: "lpAmount"; draftId: string }
  | { kind: "position"; refId: string }
  | { kind: "confirm"; actionId: string }
  /** Not rendered: the bot runs the stored action. */
  | { kind: "execute"; actionId: string };

/**
 * Telegram caps callback data at 64 bytes, too small for a vault plus two mints. Larger button
 * payloads live here and buttons carry a random id, so a button from before a restart can never
 * point at a different entry.
 * ponytail: in-memory and per process; such buttons expire on restart. Move to Redis if the bot runs replicas.
 */
export function createIdStore<T>(limit = 1000) {
  const entries = new Map<string, T>();
  return {
    put(value: T): string {
      const id = randomBytes(8).toString("base64url");
      entries.set(id, value);
      if (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return id;
    },
    get: (id: string): T | undefined => entries.get(id),
    /** One-shot read, so a confirm button cannot run its action twice. */
    take(id: string): T | undefined {
      const value = entries.get(id);
      entries.delete(id);
      return value;
    },
  };
}
export type IdStore<T> = ReturnType<typeof createIdStore<T>>;

const ADDRESS = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const STORE_ID = "([A-Za-z0-9_-]{11})";

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
      return `qq:${screen.pairId}:${screen.percent}:${screen.slippageBps}`;
    case "lpPools":
      return `lp:${screen.vault}`;
    case "lpRange":
      return `lr:${screen.draftId}`;
    case "lpAmount":
      return `la:${screen.draftId}`;
    case "position":
      return `p:${screen.refId}`;
    case "confirm":
      return `c:${screen.actionId}`;
    case "execute":
      return `x:${screen.actionId}`;
  }
}

/** Callback data arrives from the client, so anything unexpected decodes to undefined. */
export function decodeScreen(data: string): Screen | undefined {
  if (data === "vaults") return { kind: "vaults" };
  const vaultScreen = new RegExp(`^(v|h|s|qp|lp):${ADDRESS}$`).exec(data);
  if (vaultScreen) {
    const vault = vaultScreen[2] as string;
    const kinds = { v: "vault", h: "holdings", s: "strategies", qp: "quotePick", lp: "lpPools" } as const;
    return { kind: kinds[vaultScreen[1] as keyof typeof kinds], vault };
  }
  const stored = new RegExp(`^(qa|p|c|x|lr|la):${STORE_ID}$`).exec(data);
  if (stored) {
    const id = stored[2] as string;
    switch (stored[1]) {
      case "qa":
        return { kind: "quoteAmount", pairId: id };
      case "p":
        return { kind: "position", refId: id };
      case "c":
        return { kind: "confirm", actionId: id };
      case "x":
        return { kind: "execute", actionId: id };
      case "lr":
        return { kind: "lpRange", draftId: id };
      case "la":
        return { kind: "lpAmount", draftId: id };
    }
  }
  const quote = new RegExp(`^qq:${STORE_ID}:(\\d{1,3}):(\\d{1,3})$`).exec(data);
  const percent = Number(quote?.[2]);
  const slippageBps = Number(quote?.[3]);
  if (quote && (AMOUNT_PERCENTS as readonly number[]).includes(percent) && (SLIPPAGE_OPTIONS as readonly number[]).includes(slippageBps)) {
    return { kind: "quote", pairId: quote[1] as string, percent: percent as AmountPercent, slippageBps: slippageBps as SlippageBps };
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

export interface ScreenDeps {
  api: HedgeClient;
  pairs: IdStore<QuotePair>;
  positions: IdStore<PositionRef>;
  actions: IdStore<PendingAction>;
  drafts: IdStore<LpDraft>;
  /** False when no manager keypair is configured; trade buttons are hidden. */
  trading: boolean;
}

const confirmButton = (deps: ScreenDeps, text: string, action: PendingAction) =>
  button(text, { kind: "confirm", actionId: deps.actions.put(action) });

type DlmmStrategy = Extract<Strategy, { type: "dlmm" }>;
const pairLabel = (s: DlmmStrategy) => `${s.tokenX.symbol}/${s.tokenY.symbol}`;

async function findVault(api: HedgeClient, address: string): Promise<VaultSummary> {
  const vault = (await api.listVaults()).find((v) => v.address === address);
  if (!vault) throw new ScreenNotice("That vault is no longer in this API key's scope.");
  return vault;
}

/** Puts a deposit-token amount on its side of the pair; the other side is zero. */
function depositSide(pair: { tokenX: TokenRef; tokenY: TokenRef }, deposit: TokenRef, amountBaseUnits: string): LiquidityAmounts | undefined {
  const display = { amountBaseUnits, token: deposit };
  if (pair.tokenX.mint === deposit.mint) return { amountX: amountBaseUnits, amountY: "0", display };
  if (pair.tokenY.mint === deposit.mint) return { amountX: "0", amountY: amountBaseUnits, display };
  return undefined;
}

const depositBalance = (holdings: { depositToken: TokenRef; tokens: { token: TokenRef; amount: string }[] }) =>
  holdings.tokens.find((t) => t.token.mint === holdings.depositToken.mint)?.amount ?? "0";

export function percentOf(baseUnits: string, percent: AmountPercent): string {
  return ((BigInt(baseUnits) * BigInt(percent)) / 100n).toString();
}

export async function renderScreen(screen: Screen, deps: ScreenDeps): Promise<RenderedScreen> {
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
          deps.trading
            ? [button("💱 Swap", { kind: "quotePick", vault: vault.address }), button("➕ New LP position", { kind: "lpPools", vault: vault.address })]
            : [button("💱 Quote a swap", { kind: "quotePick", vault: vault.address })],
          [homeButton],
        ]),
      };
    }
    case "holdings": {
      const vault = await findVault(api, screen.vault);
      return {
        html: holdingsMessage(vault, await api.getHoldings(vault.address)),
        keyboard: keyboard([[button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton]]),
      };
    }
    case "strategies": {
      const vault = await findVault(api, screen.vault);
      const strategies = await api.getStrategies(vault.address);
      const rows = strategies.flatMap((strategy) => {
        if (strategy.type === "dlmm") {
          const refId = deps.positions.put({ vault: vault.address, position: strategy.position });
          return [[button(`⚙️ ${pairLabel(strategy)} position`, { kind: "position", refId })]];
        }
        if (strategy.type === "jupiter" && strategy.vaultBalance === "0" && deps.trading) {
          const action: PendingAction = { kind: "closeStrategy", vault: vault.address, strategy: strategy.address, label: `${strategy.symbol} swap strategy` };
          return [[confirmButton(deps, `🗑 Close empty ${strategy.symbol} strategy`, action)]];
        }
        return [];
      });
      return {
        html: strategiesMessage(vault, strategies),
        keyboard: keyboard([...rows, [button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton]]),
      };
    }
    case "position": {
      const ref = deps.positions.get(screen.refId);
      if (!ref) throw expired();
      const vault = await findVault(api, ref.vault);
      const strategy = (await api.getStrategies(vault.address)).find(
        (s): s is DlmmStrategy => s.type === "dlmm" && s.position === ref.position,
      );
      if (!strategy) throw new ScreenNotice("This position is closed or can no longer be read.");
      const back = button("⬅️ Strategies", { kind: "strategies", vault: vault.address });
      if (!deps.trading) return { html: positionMessage(vault, strategy, false), keyboard: keyboard([[button("🔄 Refresh", screen), back]]) };
      const base = { vault: vault.address, position: strategy.position, pairLabel: pairLabel(strategy) };
      const removeButton = (bps: RemoveBps) => confirmButton(deps, `➖ ${bps / 100}%`, { kind: "dlmmRemove", ...base, bps });
      const holdings = await api.getHoldings(vault.address);
      const balance = depositBalance(holdings);
      const addButtons = ADD_PERCENTS.flatMap((percent) => {
        const amounts = depositSide(strategy, holdings.depositToken, percentOf(balance, percent));
        return amounts && amounts.display.amountBaseUnits !== "0"
          ? [confirmButton(deps, `➕ ${percent}% ${holdings.depositToken.symbol}`, { kind: "dlmmAdd", ...base, amounts })]
          : [];
      });
      return {
        html: positionMessage(vault, strategy, true),
        keyboard: keyboard([
          [confirmButton(deps, "💰 Claim fees", { kind: "dlmmClaim", ...base })],
          ...(addButtons.length > 0 ? [addButtons] : []),
          REMOVE_BPS.map(removeButton),
          [confirmButton(deps, `🔁 Zap out to ${vault.depositSymbol}`, { kind: "dlmmZapOut", ...base, depositSymbol: vault.depositSymbol })],
          [button("🔄 Refresh", screen), back],
        ]),
      };
    }
    case "lpPools": {
      const vault = await findVault(api, screen.vault);
      const holdings = await api.getHoldings(vault.address);
      const deposit = holdings.depositToken;
      const { pools } = await api.searchPools(vault.address, deposit.symbol);
      // Builders require the deposit token on one side of the pair.
      const eligible = pools.filter((p) => p.tokenX.mint === deposit.mint || p.tokenY.mint === deposit.mint).slice(0, 6);
      return {
        html: lpPoolsMessage(vault, deposit.symbol, eligible),
        keyboard: keyboard([
          ...eligible.map((pool) => [
            button(`${pool.tokenX.symbol}/${pool.tokenY.symbol} · ${pool.binStep} bps bins`, {
              kind: "lpRange",
              draftId: deps.drafts.put({ vault: vault.address, lbPair: pool.address }),
            }),
          ]),
          [button("⬅️ Back", { kind: "vault", vault: vault.address })],
        ]),
      };
    }
    case "lpRange": {
      const draft = deps.drafts.get(screen.draftId);
      if (!draft) throw expired();
      const vault = await findVault(api, draft.vault);
      const [pool, holdings] = await Promise.all([api.getPool(vault.address, draft.lbPair), api.getHoldings(vault.address)]);
      const depositIsX = pool.tokenX.mint === holdings.depositToken.mint;
      return {
        html: lpRangeMessage(pool, holdings.depositToken.symbol, depositIsX),
        keyboard: keyboard([
          LP_WIDTHS.map((width) =>
            button(`${width} bins · ${depositIsX ? "+" : "−"}${rangeSpanPct(pool.binStep, width)}`, {
              kind: "lpAmount",
              draftId: deps.drafts.put({ ...draft, width }),
            }),
          ),
          [button("⬅️ Pools", { kind: "lpPools", vault: vault.address })],
        ]),
      };
    }
    case "lpAmount": {
      const draft = deps.drafts.get(screen.draftId);
      if (!draft?.width) throw expired();
      const vault = await findVault(api, draft.vault);
      const [pool, holdings] = await Promise.all([api.getPool(vault.address, draft.lbPair), api.getHoldings(vault.address)]);
      const deposit = holdings.depositToken;
      const range = singleSidedRange(pool.activeBinId, draft.width, pool.tokenX.mint === deposit.mint);
      const priceRange = rangePrices(Number(pool.activePrice), pool.activeBinId, pool.binStep, range);
      const balance = depositBalance(holdings);
      const amountButtons = AMOUNT_PERCENTS.flatMap((percent) => {
        const amounts = depositSide(pool, deposit, percentOf(balance, percent));
        if (!amounts || amounts.display.amountBaseUnits === "0") return [];
        const action: PendingAction = {
          kind: "dlmmOpen",
          vault: vault.address,
          lbPair: pool.lbPair,
          pairLabel: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
          ...range,
          priceRange,
          amounts,
        };
        return [confirmButton(deps, `${percent}%`, action)];
      });
      return {
        html: lpAmountMessage(pool, deposit, balance, priceRange, draft.width),
        keyboard: keyboard([
          ...(amountButtons.length > 0 ? [amountButtons] : []),
          [button("⬅️ Range", { kind: "lpRange", draftId: deps.drafts.put({ vault: draft.vault, lbPair: draft.lbPair }) })],
        ]),
      };
    }
    case "confirm": {
      const action = deps.actions.get(screen.actionId);
      if (!action) throw expired();
      const vault = await findVault(api, action.vault);
      const freshQuote =
        action.kind === "swap"
          ? await api.getQuote({
              vault: action.vault,
              inputMint: action.input.mint,
              outputMint: action.output.mint,
              amount: action.amountBaseUnits,
              slippageBps: action.slippageBps,
            })
          : undefined;
      return {
        html: confirmMessage(vault, action, freshQuote),
        keyboard: keyboard([
          [button("✅ Confirm and send", { kind: "execute", actionId: screen.actionId })],
          [button("✖️ Cancel", { kind: "vault", vault: vault.address })],
        ]),
      };
    }
    case "execute":
      throw new Error("execute screens are handled by the bot, not rendered");
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
      const amounts = AMOUNT_PERCENTS.map((percent) =>
        button(`${percent}%`, { kind: "quote", pairId: screen.pairId, percent, slippageBps: DEFAULT_SLIPPAGE_BPS }),
      );
      return {
        html: quoteAmountMessage(pair),
        keyboard: keyboard([amounts, [button("⬅️ Back", { kind: "quotePick", vault: pair.vault })]]),
      };
    }
    case "quote": {
      const pair = pairs.get(screen.pairId);
      if (!pair) throw expired();
      const amountBaseUnits = percentOf(pair.inputBalanceBaseUnits, screen.percent);
      const slippageRow = SLIPPAGE_OPTIONS.map((slippageBps) =>
        button(`${slippageBps === screen.slippageBps ? "✓ " : ""}${slippageBps / 100}% slippage`, { ...screen, slippageBps }),
      );
      const navRows = [
        slippageRow,
        [button("🔄 Refresh", screen), button("⬅️ Amount", { kind: "quoteAmount", pairId: screen.pairId })],
        [homeButton],
      ];
      const back = keyboard(navRows);
      if (amountBaseUnits === "0") return { html: quoteResultMessage(pair, screen.percent, undefined), keyboard: back };
      const quote = await api.getQuote({
        vault: pair.vault,
        inputMint: pair.input.mint,
        outputMint: pair.output.mint,
        amount: amountBaseUnits,
        slippageBps: screen.slippageBps,
      });
      if (!deps.trading) return { html: quoteResultMessage(pair, screen.percent, quote), keyboard: back };
      const swap: PendingAction = {
        kind: "swap",
        vault: pair.vault,
        input: pair.input,
        output: pair.output,
        amountBaseUnits,
        slippageBps: screen.slippageBps,
      };
      return {
        html: quoteResultMessage(pair, screen.percent, quote),
        keyboard: keyboard([[confirmButton(deps, `⚡ Swap ${pair.input.symbol} → ${pair.output.symbol}`, swap)], ...navRows]),
      };
    }
  }
}
