import {
  type DlmmShape,
  type HedgeClient,
  type Holdings,
  type PoolInfo,
  type PriceRange,
  binRangeForPrices,
  formatUnits,
  parseUnits,
} from "@hedginvault/sdk";
import type { PendingAction } from "./actions";
import { lpFormMessage, swapFormMessage, swapQuoteMessage } from "./messages";
import {
  type Button,
  type FormOp,
  type IdStore,
  type RenderedScreen,
  type Screen,
  ScreenNotice,
  type TextField,
  type TokenRef,
  button,
  expired,
  formButton,
  keyboard,
} from "./ui";

/** The protocol config caps swap slippage at 300 bps. */
export const MAX_SLIPPAGE_BPS = 300;
export const SLIPPAGE_PRESETS = [50, 100, 300] as const;
export const SHAPES: readonly DlmmShape[] = ["spot", "curve", "bidAsk"];
export const RANGE_PRESETS_BPS = [100, 500, 1000] as const;

/** An amount as typed: a share of the vault's balance, or an exact base-unit amount. */
export type AmountInput = { kind: "share"; bps: number } | { kind: "exact"; baseUnits: string };

export interface PickedToken extends TokenRef {
  /** Pasted by the user (warn unless Jupiter-verified) rather than picked from vault holdings. */
  pasted: boolean;
  verified: boolean | null;
}

export const needsWarning = (token: PickedToken) => token.pasted && token.verified !== true;

export interface SwapForm {
  kind: "swap";
  vault: string;
  deposit: TokenRef;
  /** buy: deposit token → `token`; sell: `token` → deposit token. */
  side: "buy" | "sell";
  token?: PickedToken;
  amount?: AmountInput;
  slippageBps: number;
  /** Non-deposit tokens the vault held when the form opened, offered as shortcuts. */
  held: PickedToken[];
}

export interface LpForm {
  kind: "lp";
  /** open: choose pool and range. add: an existing position's pool and range are fixed. */
  mode: "open" | "add";
  vault: string;
  deposit: TokenRef;
  pool?: PoolInfo;
  position?: string;
  minPrice?: number;
  maxPrice?: number;
  shape: DlmmShape;
  amountX?: AmountInput;
  amountY?: AmountInput;
  /** Results of the last typed pool search, shown as buttons. */
  poolChoices?: { address: string; label: string }[];
}

export type Form = SwapForm | LpForm;


/** A value the user typed that cannot be used; the message is shown as-is. */
export class InputError extends Error {}

/** "25%" or "max" → share of balance; anything else is an exact display amount. */
export function parseAmountInput(text: string, decimals: number): AmountInput {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "max" || trimmed === "all") return { kind: "share", bps: 10_000 };
  const percent = /^(\d+(?:\.\d{1,2})?)\s*%$/.exec(trimmed);
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    if (bps < 1 || bps > 10_000) throw new InputError("A percentage must be between 0.01% and 100%.");
    return { kind: "share", bps };
  }
  let baseUnits: string;
  try {
    baseUnits = parseUnits(trimmed, decimals);
  } catch (error) {
    throw new InputError(`${error instanceof Error ? error.message : "Not an amount"}. Try "1.5", "25%", or "max".`);
  }
  if (baseUnits === "0") throw new InputError("The amount must be more than zero.");
  return { kind: "exact", baseUnits };
}

/** Base units an input means against `balanceBaseUnits`. Exact amounts above the balance are refused. */
export function resolveAmount(input: AmountInput, balanceBaseUnits: string): string {
  const balance = BigInt(balanceBaseUnits);
  if (input.kind === "share") return ((balance * BigInt(input.bps)) / 10_000n).toString();
  if (BigInt(input.baseUnits) > balance) throw new InputError("That is more than the vault holds.");
  return input.baseUnits;
}

/** "0.8", "0.8%", or "80bps" → basis points, capped by the protocol. */
export function parseSlippage(text: string): number {
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, "");
  const bpsMatch = /^(\d+)bps$/.exec(trimmed);
  const percentMatch = /^(\d+(?:\.\d{1,2})?)%?$/.exec(trimmed);
  const bps = bpsMatch ? Number(bpsMatch[1]) : percentMatch ? Math.round(Number(percentMatch[1]) * 100) : Number.NaN;
  if (!Number.isInteger(bps) || bps < 1) throw new InputError('Send slippage as a percent like "0.8" or as "80bps".');
  if (bps > MAX_SLIPPAGE_BPS) throw new InputError(`The protocol caps slippage at ${MAX_SLIPPAGE_BPS / 100}%.`);
  return bps;
}

export function parsePrice(text: string): number {
  const price = Number(text.trim().replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) throw new InputError('Send a positive price like "142.5".');
  return price;
}

export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function swapTokens(form: SwapForm): { input: TokenRef; output: TokenRef } | undefined {
  if (!form.token) return undefined;
  return form.side === "buy" ? { input: form.deposit, output: form.token } : { input: form.token, output: form.deposit };
}

export const describeAmount = (input: AmountInput | undefined, token: TokenRef | undefined, format: (base: string, decimals: number) => string) =>
  !input ? "not set" : input.kind === "share" ? (input.bps === 10_000 ? "max" : `${input.bps / 100}% of balance`) : `${format(input.baseUnits, token?.decimals ?? 0)} ${token?.symbol ?? ""}`.trim();

export interface FormDeps {
  api: HedgeClient;
  forms: IdStore<Form>;
  actions: IdStore<PendingAction>;
  trading: boolean;
}

/** After a button: show a screen, or ask the user to type a field. */
export type FormResult = { kind: "show"; screen: Screen } | { kind: "ask"; field: TextField; prompt: string };

const DEFAULT_RANGE_BPS = 500;
const SHAPE_LABEL: Record<DlmmShape, string> = { spot: "Spot", curve: "Curve", bidAsk: "Bid-Ask" };
export const shapeLabel = (shape: DlmmShape) => SHAPE_LABEL[shape];

const balanceOf = (holdings: Holdings, mint: string) => holdings.tokens.find((t) => t.token.mint === mint)?.amount ?? "0";
const tokenRef = ({ mint, symbol, decimals }: TokenRef): TokenRef => ({ mint, symbol, decimals });
export const fmt = (baseUnits: string, token: TokenRef) => `${formatUnits(baseUnits, token.decimals)} ${token.symbol}`;

export async function createSwapForm(api: HedgeClient, vault: string): Promise<SwapForm> {
  const holdings = await api.getHoldings(vault);
  const deposit = tokenRef(holdings.depositToken);
  const held = holdings.tokens
    .filter((t) => t.token.mint !== deposit.mint)
    .slice(0, 4)
    .map((t) => ({ ...tokenRef(t.token), pasted: false, verified: null }));
  return { kind: "swap", vault, deposit, side: "buy", slippageBps: SLIPPAGE_PRESETS[0], held };
}

export async function createLpForm(api: HedgeClient, vault: string, position?: { position: string; lbPair: string }): Promise<LpForm> {
  const holdings = await api.getHoldings(vault);
  const form: LpForm = { kind: "lp", mode: position ? "add" : "open", vault, deposit: tokenRef(holdings.depositToken), shape: "spot" };
  if (position) {
    form.position = position.position;
    form.pool = await api.getPool(vault, position.lbPair);
  }
  return form;
}

function setPool(form: LpForm, pool: PoolInfo): void {
  if (pool.tokenX.mint !== form.deposit.mint && pool.tokenY.mint !== form.deposit.mint) {
    throw new InputError(`That pool does not include the vault's deposit token, ${form.deposit.symbol}.`);
  }
  form.pool = pool;
  form.poolChoices = undefined;
  form.amountX = undefined;
  form.amountY = undefined;
  setRange(form, DEFAULT_RANGE_BPS);
}

function setRange(form: LpForm, bps: number): void {
  const active = Number(form.pool?.activePrice);
  form.minPrice = active * (1 - bps / 10_000);
  form.maxPrice = active * (1 + bps / 10_000);
}

/** The bin range the form's prices cover, or the reason it has none. */
export function formRange(form: LpForm): PriceRange | string {
  if (!form.pool || form.minPrice === undefined || form.maxPrice === undefined) return "Set a min and max price.";
  try {
    return binRangeForPrices(form.pool, form.minPrice, form.maxPrice);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid range";
  }
}

const PROMPTS: Record<TextField, string> = {
  token: "📋 Paste the token's contract address (mint).",
  amount: 'How much? Send an amount like "1.5", a share like "25%", or "max".',
  slippage: 'Send slippage as a percent like "0.8" or as "80bps" (max 3%).',
  pool: "🏊 Paste a Meteora DLMM pool address, or type a token symbol to search.",
  minPrice: "⬇️ Send the minimum price, in the pool's quote token per base token.",
  maxPrice: "⬆️ Send the maximum price, in the pool's quote token per base token.",
  amountX: 'How much of the first token? Send "1.5", "25%", or "max". Send "0" to clear.',
  amountY: 'How much of the second token? Send "1.5", "25%", or "max". Send "0" to clear.',
};

function getForm(deps: FormDeps, formId: string): Form {
  const form = deps.forms.get(formId);
  if (!form) throw expired();
  return form;
}

export async function applyFormOp(formId: string, op: FormOp, deps: FormDeps): Promise<FormResult> {
  const form = getForm(deps, formId);
  const show: FormResult = { kind: "show", screen: { kind: "form", formId } };
  if (op.op === "ask") return { kind: "ask", field: op.field, prompt: PROMPTS[op.field] };
  if (form.kind === "swap") {
    switch (op.op) {
      case "side":
        form.side = form.side === "buy" ? "sell" : "buy";
        form.amount = undefined;
        return show;
      case "token": {
        const token = form.held[op.index];
        if (!token) throw expired();
        form.token = token;
        form.amount = undefined;
        return show;
      }
      case "share":
        form.amount = { kind: "share", bps: op.bps };
        return show;
      case "slippage":
        form.slippageBps = op.bps;
        return show;
      case "quote":
        if (!form.token || !form.amount) throw new InputError("Pick a token and an amount first.");
        return { kind: "show", screen: { kind: "swapQuote", formId } };
      default:
        throw expired();
    }
  }
  switch (op.op) {
    case "shape":
      form.shape = SHAPES[(SHAPES.indexOf(form.shape) + 1) % SHAPES.length] ?? "spot";
      return show;
    case "pool": {
      const choice = form.poolChoices?.[op.index];
      if (!choice) throw expired();
      setPool(form, await deps.api.getPool(form.vault, choice.address));
      return show;
    }
    case "range":
      if (!form.pool) throw new InputError("Pick a pool first.");
      setRange(form, op.bps);
      return show;
    case "review":
      return { kind: "show", screen: { kind: "confirm", actionId: deps.actions.put(await lpAction(form, deps.api)) } };
    default:
      throw expired();
  }
}

export async function applyFormText(formId: string, field: TextField, text: string, deps: FormDeps): Promise<void> {
  const form = getForm(deps, formId);
  if (form.kind === "swap") {
    switch (field) {
      case "token": {
        const mint = text.trim();
        if (!BASE58_ADDRESS.test(mint)) throw new InputError("That is not a Solana address. Paste the token's mint address.");
        if (mint === form.deposit.mint) throw new InputError(`That is the deposit token, ${form.deposit.symbol}. Paste the other token.`);
        const detail = await deps.api.getToken(form.vault, mint);
        form.token = { ...tokenRef(detail), pasted: true, verified: detail.verified };
        form.amount = undefined;
        return;
      }
      case "amount": {
        const tokens = swapTokens(form);
        if (!tokens) throw new InputError("Pick the token first.");
        form.amount = parseAmountInput(text, tokens.input.decimals);
        return;
      }
      case "slippage":
        form.slippageBps = parseSlippage(text);
        return;
      default:
        throw expired();
    }
  }
  switch (field) {
    case "pool": {
      const query = text.trim();
      if (BASE58_ADDRESS.test(query)) {
        setPool(form, await deps.api.getPool(form.vault, query));
        return;
      }
      const { pools } = await deps.api.searchPools(form.vault, query);
      const eligible = pools.filter((p) => p.tokenX.mint === form.deposit.mint || p.tokenY.mint === form.deposit.mint).slice(0, 6);
      if (eligible.length === 0) throw new InputError(`No pool matching "${query}" pairs with ${form.deposit.symbol}.`);
      form.poolChoices = eligible.map((p) => ({ address: p.address, label: `${p.tokenX.symbol}/${p.tokenY.symbol} · ${p.binStep} bps` }));
      return;
    }
    case "minPrice":
      form.minPrice = parsePrice(text);
      return;
    case "maxPrice":
      form.maxPrice = parsePrice(text);
      return;
    case "amountX":
    case "amountY": {
      if (!form.pool) throw new InputError("Pick a pool first.");
      const token = field === "amountX" ? form.pool.tokenX : form.pool.tokenY;
      const value = text.trim() === "0" ? undefined : parseAmountInput(text, token.decimals);
      if (field === "amountX") form.amountX = value;
      else form.amountY = value;
      return;
    }
    default:
      throw expired();
  }
}

async function lpAction(form: LpForm, api: HedgeClient): Promise<PendingAction> {
  const pool = form.pool;
  if (!pool) throw new InputError("Pick a pool first.");
  if (!form.amountX && !form.amountY) throw new InputError("Set an amount for at least one token.");
  const holdings = await api.getHoldings(form.vault);
  const amountX = form.amountX ? resolveAmount(form.amountX, balanceOf(holdings, pool.tokenX.mint)) : "0";
  const amountY = form.amountY ? resolveAmount(form.amountY, balanceOf(holdings, pool.tokenY.mint)) : "0";
  if (amountX === "0" && amountY === "0") throw new InputError("Those amounts are zero at the vault's current balances.");
  const liquidity = { tokenX: tokenRef(pool.tokenX), tokenY: tokenRef(pool.tokenY), amountX, amountY, shape: form.shape };
  const pairLabel = `${pool.tokenX.symbol}/${pool.tokenY.symbol}`;
  if (form.mode === "add") {
    if (!form.position) throw expired();
    return { kind: "dlmmAdd", vault: form.vault, position: form.position, pairLabel, liquidity };
  }
  const range = formRange(form);
  if (typeof range === "string") throw new InputError(range);
  if (range.sides === "y" && amountX !== "0") throw new InputError(`The range is below the price, so it can only hold ${pool.tokenY.symbol}. Clear the ${pool.tokenX.symbol} amount.`);
  if (range.sides === "x" && amountY !== "0") throw new InputError(`The range is above the price, so it can only hold ${pool.tokenX.symbol}. Clear the ${pool.tokenY.symbol} amount.`);
  return {
    kind: "dlmmOpen",
    vault: form.vault,
    lbPair: pool.lbPair,
    pairLabel,
    lowerBinId: range.lowerBinId,
    upperBinId: range.upperBinId,
    priceRange: { low: formatPrice(range.lowPrice), high: formatPrice(range.highPrice) },
    liquidity,
  };
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "?";
  return price >= 1 ? price.toLocaleString("en-US", { maximumFractionDigits: 4 }) : price.toPrecision(4);
}

export async function renderForm(formId: string, deps: FormDeps): Promise<RenderedScreen> {
  const form = getForm(deps, formId);
  const holdings = await deps.api.getHoldings(form.vault);
  return form.kind === "swap" ? renderSwapForm(formId, form, holdings, deps) : renderLpForm(formId, form, holdings);
}

function renderSwapForm(formId: string, form: SwapForm, holdings: Holdings, deps: FormDeps): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const tokens = swapTokens(form);
  const inputBalance = tokens ? balanceOf(holdings, tokens.input.mint) : undefined;
  const rows: Button[][] = [
    [op(form.side === "buy" ? `🟢 Buying · tap to sell` : `🔴 Selling · tap to buy`, { op: "side" })],
    [
      ...form.held.map((token, index) => op(`${form.token?.mint === token.mint ? "✓ " : ""}${token.symbol}`, { op: "token", index })),
      op("📋 Paste CA", { op: "ask", field: "token" }),
    ],
  ];
  if (tokens) {
    rows.push([
      ...[2500, 5000, 10_000].map((bps) =>
        op(`${form.amount?.kind === "share" && form.amount.bps === bps ? "✓ " : ""}${bps === 10_000 ? "Max" : `${bps / 100}%`}`, { op: "share", bps }),
      ),
      op("✏️ Amount", { op: "ask", field: "amount" }),
    ]);
  }
  rows.push([
    ...SLIPPAGE_PRESETS.map((bps) => op(`${form.slippageBps === bps ? "✓ " : ""}${bps / 100}%`, { op: "slippage", bps })),
    op(SLIPPAGE_PRESETS.includes(form.slippageBps as (typeof SLIPPAGE_PRESETS)[number]) ? "✏️ Slippage" : `✓ ${form.slippageBps / 100}% ✏️`, { op: "ask", field: "slippage" }),
  ]);
  if (form.token && form.amount) rows.push([op(deps.trading ? "📈 Quote & review" : "📈 Get quote", { op: "quote" })]);
  rows.push([button("⬅️ Vault", { kind: "vault", vault: form.vault })]);
  return { html: swapFormMessage(form, inputBalance), keyboard: keyboard(rows) };
}

function renderLpForm(formId: string, form: LpForm, holdings: Holdings): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const pool = form.pool;
  const range = form.mode === "open" ? formRange(form) : undefined;
  const rows: Button[][] = [];
  if (form.mode === "open") {
    rows.push([op(pool ? "🏊 Change pool" : "🏊 Pick pool", { op: "ask", field: "pool" })]);
    form.poolChoices?.forEach((choice, index) => rows.push([op(choice.label, { op: "pool", index })]));
  }
  rows.push([op(`📐 Shape: ${shapeLabel(form.shape)} · tap to change`, { op: "shape" })]);
  if (pool && form.mode === "open") {
    rows.push(RANGE_PRESETS_BPS.map((bps) => op(`±${bps / 100}%`, { op: "range", bps })));
    rows.push([op("⬇️ Min price", { op: "ask", field: "minPrice" }), op("⬆️ Max price", { op: "ask", field: "maxPrice" })]);
  }
  if (pool) {
    const sides = range && typeof range !== "string" ? range.sides : "both";
    const amountButtons: Button[] = [];
    if (sides !== "y") amountButtons.push(op(`💧 ${pool.tokenX.symbol} amount`, { op: "ask", field: "amountX" }));
    if (sides !== "x") amountButtons.push(op(`💧 ${pool.tokenY.symbol} amount`, { op: "ask", field: "amountY" }));
    rows.push(amountButtons);
    if ((form.amountX || form.amountY) && (form.mode === "add" || (range && typeof range !== "string"))) rows.push([op("✅ Review", { op: "review" })]);
  }
  rows.push([button("⬅️ Vault", { kind: "vault", vault: form.vault })]);
  const balances = pool ? { x: balanceOf(holdings, pool.tokenX.mint), y: balanceOf(holdings, pool.tokenY.mint) } : undefined;
  return { html: lpFormMessage(form, range, balances), keyboard: keyboard(rows) };
}

/** Quotes the swap form and offers the confirm step. */
export async function renderSwapQuote(formId: string, deps: FormDeps): Promise<RenderedScreen> {
  const form = getForm(deps, formId);
  if (form.kind !== "swap") throw expired();
  const tokens = swapTokens(form);
  if (!tokens || !form.amount || !form.token) throw new ScreenNotice("Pick a token and an amount first.");
  const holdings = await deps.api.getHoldings(form.vault);
  const amountBaseUnits = resolveAmount(form.amount, balanceOf(holdings, tokens.input.mint));
  if (amountBaseUnits === "0") throw new InputError(`The vault holds no ${tokens.input.symbol}.`);
  const quote = await deps.api.getQuote({
    vault: form.vault,
    inputMint: tokens.input.mint,
    outputMint: tokens.output.mint,
    amount: amountBaseUnits,
    slippageBps: form.slippageBps,
  });
  const rows: Button[][] = [];
  if (deps.trading) {
    const action: PendingAction = {
      kind: "swap",
      vault: form.vault,
      ...tokens,
      amountBaseUnits,
      slippageBps: form.slippageBps,
      unverified: needsWarning(form.token),
    };
    rows.push([button(`⚡ Swap ${tokens.input.symbol} → ${tokens.output.symbol}`, { kind: "confirm", actionId: deps.actions.put(action) })]);
  }
  rows.push([button("🔄 Refresh", { kind: "swapQuote", formId }), button("✏️ Edit", { kind: "form", formId })]);
  return { html: swapQuoteMessage(form, tokens, amountBaseUnits, quote), keyboard: keyboard(rows) };
}
