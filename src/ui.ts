import { randomBytes } from "node:crypto";
import { Markup } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";

export interface TokenRef {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface PositionRef {
  vault: string;
  position: string;
}

/** What a form button does; encoded into callback data after the form id. */
export type FormOp =
  | { op: "side" }
  /** LP form: pick `SHAPES[index]`. */
  | { op: "shape"; index: number }
  /** LP form: pick `LP_SIDES[index]`. */
  | { op: "lpSide"; index: number }
  /** LP form: open the amount picker for tokenX (0) or tokenY (1), or close it (2). */
  | { op: "amountPick"; index: number }
  | { op: "slippage"; bps: number }
  | { op: "share"; bps: number }
  | { op: "ask"; field: TextField }
  | { op: "token"; index: number }
  | { op: "pool"; index: number }
  | { op: "range"; bps: number }
  | { op: "quote" }
  | { op: "review" }
  /** LP form: create the position without liquidity. */
  | { op: "empty" }
  | { op: "market"; index: number }
  | { op: "orderType" }
  | { op: "postOnly" }
  | { op: "reduceOnly" }
  | { op: "usdc" };

/**
 * Which bins of a position a remove takes: all, only those strictly above or below the price, or a
 * quick pick of the position's highest- or lowest-price bins.
 */
// Append only: callback data carries the index.
export const REMOVE_BINS = ["all", "above", "below", "top25", "top50", "bottom25", "bottom50"] as const;
export type RemoveBins = (typeof REMOVE_BINS)[number];

// Append only: callback data carries a field's index.
const TEXT_FIELDS = [
  "token",
  "amount",
  "slippage",
  "pool",
  "minPrice",
  "maxPrice",
  "amountX",
  "amountY",
  "symbol",
  "size",
  "price",
  "orderSlippage",
  "name",
  "performanceFee",
  "managementFee",
  "depositCap",
  "minDeposit",
  "minWithdrawalShares",
  "removeRange",
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export type Screen =
  | { kind: "vaults" }
  | { kind: "vault"; vault: string }
  | { kind: "strategies"; vault: string }
  | { kind: "newSwap"; vault: string }
  | { kind: "newLp"; vault: string }
  | { kind: "navHistory"; vault: string }
  | { kind: "requests"; vault: string }
  | { kind: "strategyHistory"; vault: string }
  | { kind: "settings"; vault: string }
  | { kind: "editSettings"; vault: string }
  | { kind: "phoenix"; vault: string }
  | { kind: "phoenixDeposit"; vault: string }
  | { kind: "phoenixWithdraw"; vault: string }
  | { kind: "newOrder"; vault: string }
  | { kind: "trackToken"; vault: string }
  | { kind: "newVault" }
  | { kind: "position"; refId: string }
  | { kind: "addLp"; refId: string }
  /** Pick which bins to remove from, then how much. */
  | { kind: "removeLp"; refId: string }
  | { kind: "removeBins"; refId: string; bins: RemoveBins }
  | { kind: "form"; formId: string }
  | { kind: "formOp"; formId: string; op: FormOp }
  | { kind: "swapQuote"; formId: string }
  | { kind: "confirm"; actionId: string }
  /** Not rendered: the bot runs the stored action. */
  | { kind: "execute"; actionId: string }
  | WalletScreen;

/** Wallet management; handled by the bot because most of these change stored wallets. */
export type WalletScreen =
  | { kind: "wallet" }
  | { kind: "wallets" }
  | { kind: "walletNew" }
  | { kind: "walletImport" }
  | { kind: "walletApiKey" }
  | { kind: "walletExport" }
  | { kind: "walletReveal" }
  | { kind: "walletUse"; walletId: string }
  | { kind: "walletRemove"; walletId: string }
  | { kind: "walletRemoved"; walletId: string };

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

const ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const STORE_ID = "[A-Za-z0-9_-]{11}";

function encodeOp(op: FormOp): string {
  switch (op.op) {
    case "side":
    case "quote":
    case "review":
    case "empty":
    case "orderType":
    case "postOnly":
    case "reduceOnly":
    case "usdc":
      return op.op;
    case "market":
      return `mk${op.index}`;
    case "slippage":
      return `sl${op.bps}`;
    case "share":
      return `sh${op.bps}`;
    case "range":
      return `rg${op.bps}`;
    case "ask":
      return `ask${TEXT_FIELDS.indexOf(op.field)}`;
    case "token":
      return `tk${op.index}`;
    case "pool":
      return `pl${op.index}`;
    case "shape":
      return `sp${op.index}`;
    case "lpSide":
      return `ls${op.index}`;
    case "amountPick":
      return `ap${op.index}`;
  }
}

const PLAIN_OPS = ["side", "quote", "review", "empty", "orderType", "postOnly", "reduceOnly", "usdc"] as const;
export const MAX_MARKET_BUTTONS = 16;

function decodeOp(text: string): FormOp | undefined {
  for (const plain of PLAIN_OPS) if (text === plain) return { op: plain };
  const match = /^(sl|sh|rg|ask|tk|pl|mk|sp|ls|ap)(\d{1,5})$/.exec(text);
  if (!match) return undefined;
  const n = Number(match[2]);
  switch (match[1]) {
    case "sl":
      return n >= 1 && n <= 10_000 ? { op: "slippage", bps: n } : undefined;
    case "sh":
      return n >= 1 && n <= 10_000 ? { op: "share", bps: n } : undefined;
    case "rg":
      return n >= 1 && n < 10_000 ? { op: "range", bps: n } : undefined;
    case "ask": {
      const field = TEXT_FIELDS[n];
      return field ? { op: "ask", field } : undefined;
    }
    case "tk":
      return n < 20 ? { op: "token", index: n } : undefined;
    case "pl":
      return n < 20 ? { op: "pool", index: n } : undefined;
    case "mk":
      return n < MAX_MARKET_BUTTONS ? { op: "market", index: n } : undefined;
    // Three DLMM shapes and three LP sides; forms.ts owns the lists.
    case "sp":
      return n < 3 ? { op: "shape", index: n } : undefined;
    case "ls":
      return n < 3 ? { op: "lpSide", index: n } : undefined;
    case "ap":
      return n < 3 ? { op: "amountPick", index: n } : undefined;
  }
  return undefined;
}

const VAULT_SCREENS = {
  v: "vault",
  s: "strategies",
  ns: "newSwap",
  nl: "newLp",
  nh: "navHistory",
  rq: "requests",
  sy: "strategyHistory",
  st: "settings",
  se: "editSettings",
  px: "phoenix",
  pd: "phoenixDeposit",
  pw: "phoenixWithdraw",
  po: "newOrder",
  tt: "trackToken",
} as const;
const STORE_SCREENS = { p: "position", al: "addLp", rl: "removeLp", f: "form", q: "swapQuote", c: "confirm", x: "execute" } as const;
const WALLET_SCREENS = { w: "wallet", ws: "wallets", wn: "walletNew", wi: "walletImport", wk: "walletApiKey", we: "walletExport", wx: "walletReveal" } as const;
const WALLET_ID_SCREENS = { wu: "walletUse", wr: "walletRemove", wd: "walletRemoved" } as const;
type VaultScreenKind = (typeof VAULT_SCREENS)[keyof typeof VAULT_SCREENS];
type StoreScreenKind = (typeof STORE_SCREENS)[keyof typeof STORE_SCREENS];
type WalletScreenKind = (typeof WALLET_SCREENS)[keyof typeof WALLET_SCREENS];
type WalletIdScreenKind = (typeof WALLET_ID_SCREENS)[keyof typeof WALLET_ID_SCREENS];
const WALLET_SCREEN_KINDS: ReadonlySet<string> = new Set([...Object.values(WALLET_SCREENS), ...Object.values(WALLET_ID_SCREENS)]);
export const isWalletScreen = (screen: Screen): screen is WalletScreen => WALLET_SCREEN_KINDS.has(screen.kind);
const prefixOf = <K extends string>(table: Record<string, K>, kind: K) => Object.entries(table).find(([, k]) => k === kind)?.[0] ?? "";

export function encodeScreen(screen: Screen): string {
  switch (screen.kind) {
    case "vaults":
      return "vaults";
    case "newVault":
      return "newVault";
    case "vault":
    case "strategies":
    case "newSwap":
    case "newLp":
    case "navHistory":
    case "requests":
    case "strategyHistory":
    case "settings":
    case "editSettings":
    case "phoenix":
    case "phoenixDeposit":
    case "phoenixWithdraw":
    case "newOrder":
    case "trackToken":
      return `${prefixOf<VaultScreenKind>(VAULT_SCREENS, screen.kind)}:${screen.vault}`;
    case "position":
    case "addLp":
    case "removeLp":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.refId}`;
    case "removeBins":
      return `rb${REMOVE_BINS.indexOf(screen.bins)}:${screen.refId}`;
    case "form":
    case "swapQuote":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.formId}`;
    case "confirm":
    case "execute":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.actionId}`;
    case "formOp":
      return `o:${screen.formId}:${encodeOp(screen.op)}`;
    case "wallet":
    case "wallets":
    case "walletNew":
    case "walletImport":
    case "walletApiKey":
    case "walletExport":
    case "walletReveal":
      return prefixOf<WalletScreenKind>(WALLET_SCREENS, screen.kind);
    case "walletUse":
    case "walletRemove":
    case "walletRemoved":
      return `${prefixOf<WalletIdScreenKind>(WALLET_ID_SCREENS, screen.kind)}:${screen.walletId}`;
  }
}

/** Callback data arrives from the client, so anything unexpected decodes to undefined. */
export function decodeScreen(data: string): Screen | undefined {
  if (data === "vaults") return { kind: "vaults" };
  if (data === "newVault") return { kind: "newVault" };
  if (Object.hasOwn(WALLET_SCREENS, data)) return { kind: WALLET_SCREENS[data as keyof typeof WALLET_SCREENS] };
  const wallet = new RegExp(`^(${Object.keys(WALLET_ID_SCREENS).join("|")}):(${STORE_ID})$`).exec(data);
  if (wallet) return { kind: WALLET_ID_SCREENS[wallet[1] as keyof typeof WALLET_ID_SCREENS], walletId: wallet[2] as string };
  const vault = new RegExp(`^(${Object.keys(VAULT_SCREENS).join("|")}):(${ADDRESS})$`).exec(data);
  if (vault) return { kind: VAULT_SCREENS[vault[1] as keyof typeof VAULT_SCREENS], vault: vault[2] as string };
  const stored = new RegExp(`^(${Object.keys(STORE_SCREENS).join("|")}):(${STORE_ID})$`).exec(data);
  if (stored) {
    const id = stored[2] as string;
    const kind = STORE_SCREENS[stored[1] as keyof typeof STORE_SCREENS];
    if (kind === "position" || kind === "addLp" || kind === "removeLp") return { kind, refId: id };
    if (kind === "form" || kind === "swapQuote") return { kind, formId: id };
    return { kind, actionId: id };
  }
  const removeBins = new RegExp(`^rb([0-6]):(${STORE_ID})$`).exec(data);
  const bins = removeBins && REMOVE_BINS[Number(removeBins[1])];
  if (removeBins && bins) return { kind: "removeBins", refId: removeBins[2] as string, bins };
  const formOp = new RegExp(`^o:(${STORE_ID}):(\\w{2,10})$`).exec(data);
  const op = formOp && decodeOp(formOp[2] as string);
  return formOp && op ? { kind: "formOp", formId: formOp[1] as string, op } : undefined;
}

export interface RenderedScreen {
  html: string;
  keyboard: InlineKeyboardMarkup;
}

/** A button that can no longer be served; shown to the user as-is. */
export class ScreenNotice extends Error {}
export const expired = () => new ScreenNotice("This button expired. Send /start to begin again.");

export const button = (text: string, screen: Screen) => Markup.button.callback(text, encodeScreen(screen));
export type Button = ReturnType<typeof button>;
export const keyboard = (rows: Button[][]) => Markup.inlineKeyboard(rows).reply_markup;
export const homeButton = () => button("🏦 Vaults", { kind: "vaults" });
export const walletButton = () => button("👛 Wallet", { kind: "wallet" });
export const formButton = (text: string, formId: string, op: FormOp) => button(text, { kind: "formOp", formId, op });
/** Lays buttons out `perRow` to a row. */
export const rowsOf = (buttons: Button[], perRow: number): Button[][] =>
  Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, row) => buttons.slice(row * perRow, (row + 1) * perRow));
