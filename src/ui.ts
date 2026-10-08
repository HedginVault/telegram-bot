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
  | { op: "shape" }
  | { op: "slippage"; bps: number }
  | { op: "share"; bps: number }
  | { op: "ask"; field: TextField }
  | { op: "token"; index: number }
  | { op: "pool"; index: number }
  | { op: "range"; bps: number }
  | { op: "quote" }
  | { op: "review" };

export type TextField = "token" | "amount" | "slippage" | "pool" | "minPrice" | "maxPrice" | "amountX" | "amountY";
const TEXT_FIELDS: readonly TextField[] = ["token", "amount", "slippage", "pool", "minPrice", "maxPrice", "amountX", "amountY"];

export type Screen =
  | { kind: "vaults" }
  | { kind: "vault"; vault: string }
  | { kind: "holdings"; vault: string }
  | { kind: "strategies"; vault: string }
  | { kind: "newSwap"; vault: string }
  | { kind: "newLp"; vault: string }
  | { kind: "position"; refId: string }
  | { kind: "addLp"; refId: string }
  | { kind: "form"; formId: string }
  | { kind: "formOp"; formId: string; op: FormOp }
  | { kind: "swapQuote"; formId: string }
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

const ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const STORE_ID = "[A-Za-z0-9_-]{11}";

function encodeOp(op: FormOp): string {
  switch (op.op) {
    case "side":
    case "shape":
    case "quote":
    case "review":
      return op.op;
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
  }
}

function decodeOp(text: string): FormOp | undefined {
  if (text === "side" || text === "shape" || text === "quote" || text === "review") return { op: text };
  const match = /^(sl|sh|rg|ask|tk|pl)(\d{1,5})$/.exec(text);
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
  }
  return undefined;
}

const VAULT_SCREENS = { v: "vault", h: "holdings", s: "strategies", ns: "newSwap", nl: "newLp" } as const;
const STORE_SCREENS = { p: "position", al: "addLp", f: "form", q: "swapQuote", c: "confirm", x: "execute" } as const;
type VaultScreenKind = (typeof VAULT_SCREENS)[keyof typeof VAULT_SCREENS];
type StoreScreenKind = (typeof STORE_SCREENS)[keyof typeof STORE_SCREENS];
const prefixOf = <K extends string>(table: Record<string, K>, kind: K) => Object.entries(table).find(([, k]) => k === kind)?.[0] ?? "";

export function encodeScreen(screen: Screen): string {
  switch (screen.kind) {
    case "vaults":
      return "vaults";
    case "vault":
    case "holdings":
    case "strategies":
    case "newSwap":
    case "newLp":
      return `${prefixOf<VaultScreenKind>(VAULT_SCREENS, screen.kind)}:${screen.vault}`;
    case "position":
    case "addLp":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.refId}`;
    case "form":
    case "swapQuote":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.formId}`;
    case "confirm":
    case "execute":
      return `${prefixOf<StoreScreenKind>(STORE_SCREENS, screen.kind)}:${screen.actionId}`;
    case "formOp":
      return `o:${screen.formId}:${encodeOp(screen.op)}`;
  }
}

/** Callback data arrives from the client, so anything unexpected decodes to undefined. */
export function decodeScreen(data: string): Screen | undefined {
  if (data === "vaults") return { kind: "vaults" };
  const vault = new RegExp(`^(${Object.keys(VAULT_SCREENS).join("|")}):(${ADDRESS})$`).exec(data);
  if (vault) return { kind: VAULT_SCREENS[vault[1] as keyof typeof VAULT_SCREENS], vault: vault[2] as string };
  const stored = new RegExp(`^(${Object.keys(STORE_SCREENS).join("|")}):(${STORE_ID})$`).exec(data);
  if (stored) {
    const id = stored[2] as string;
    const kind = STORE_SCREENS[stored[1] as keyof typeof STORE_SCREENS];
    if (kind === "position" || kind === "addLp") return { kind, refId: id };
    if (kind === "form" || kind === "swapQuote") return { kind, formId: id };
    return { kind, actionId: id };
  }
  const formOp = new RegExp(`^o:(${STORE_ID}):(\\w{2,8})$`).exec(data);
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
export const formButton = (text: string, formId: string, op: FormOp) => button(text, { kind: "formOp", formId, op });
