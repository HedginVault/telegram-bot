import {
  type DlmmShape,
  type HedgeClient,
  type InclusiveBinRange,
  type PoolInfo,
  type PriceRange,
  type VaultDetail,
  binRangeForPrices,
  formatUnits,
  parseUnits,
} from "@hedginvault/sdk";
import type { PendingAction, VaultChanges } from "./actions";
import { lpAmountMessage, lpFormMessage, orderFormMessage, phoenixTransferFormMessage, swapAmountMessage, swapCardMessage, swapPickerMessage, swapQuoteMessage, swapSlippageMessage, trackFormMessage, vaultFormMessage } from "./messages";
import {
  type Button,
  type FormOp,
  type IdStore,
  type RenderedScreen,
  type Screen,
  ScreenNotice,
  type TextField,
  type TokenRef,
  MAX_MARKET_BUTTONS,
  button,
  expired,
  formButton,
  keyboard,
  rowsOf,
} from "./ui";
import { feePct } from "./format";

/** The protocol config caps swap slippage at 300 bps. */
export const MAX_SLIPPAGE_BPS = 300;
export const SLIPPAGE_PRESETS = [50, 100, 300] as const;
/** Held tokens the swap picker offers: with 📋 Paste CA, three full rows of three. */
const SWAP_PICKER_TOKENS = 8;
const SWAP_AMOUNT_PRESETS = [2500, 5000, 10_000] as const;
export const SHAPES: readonly DlmmShape[] = ["spot", "curve", "bidAsk"];
/** Which tokens a new position holds: x only (range above the price), both, or y only (below). Button order. */
export const LP_SIDES = ["x", "both", "y"] as const;
export type LpSide = (typeof LP_SIDES)[number];
/** Range presets by side: ± around the price for both, distance from the price for one side. */
export const RANGE_PRESETS_BPS: Record<LpSide, readonly number[]> = {
  both: [100, 200, 500, 1000, 2000],
  x: [500, 1000, 2000, 5000, 9000],
  y: [500, 1000, 2000, 5000, 9000],
};
const DEFAULT_RANGE_BPS: Record<LpSide, number> = { both: 500, x: 1000, y: 1000 };
/** `phoenix/order` accepts market slippage of 1..2000 bps. */
export const MAX_ORDER_SLIPPAGE_BPS = 2000;
export const ORDER_SLIPPAGE_PRESETS = [50, 100, 300] as const;
/** `dlmm/initialize` takes at most this many bins. */
export const MAX_EMPTY_POSITION_BINS = 70;
export const MAX_VAULT_NAME_BYTES = 32;
/** u64::MAX: a deposit cap that never binds. */
export const NO_DEPOSIT_CAP = "18446744073709551615";
export const USDC: TokenRef = { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 };

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
  /**
   * The screen follows from these: no token → picker; token, no side → card (choose buy or sell);
   * token and side → amount screen. `slippageOpen` shows the slippage screen over the card.
   */
  token?: PickedToken;
  /** buy: deposit token → `token`; sell: `token` → deposit token. */
  side?: "buy" | "sell";
  amount?: AmountInput;
  slippageBps: number;
  slippageOpen?: boolean;
  /** Non-deposit tokens the vault held when the form opened, offered in the picker. */
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
  /** Pool fee from the search result it was picked from; null when pasted by address or adding. */
  baseFeePct: number | null;
  minPrice?: number;
  maxPrice?: number;
  side: LpSide;
  /** The range preset in use; unset once the user types a min or max price. */
  rangeBps?: number;
  shape: DlmmShape;
  amountX?: AmountInput;
  amountY?: AmountInput;
  /** Which token's amount picker replaces the form, if any. */
  picking?: "amountX" | "amountY";
  /** The last typed pool search and its results, shown as buttons. */
  poolQuery?: string;
  poolChoices?: PoolChoice[];
}

/** A pool search result; display numbers come from the API as floats. */
export interface PoolChoice {
  address: string;
  pair: string;
  binStep: number;
  /** Percent, e.g. 0.2 = 0.2%. */
  baseFeePct: number | null;
  tvl: number | null;
  volume24h: number | null;
}

export interface PhoenixTransferForm {
  kind: "phoenixTransfer";
  /** deposit: vault USDC → Phoenix collateral. withdraw: collateral → vault. */
  direction: "deposit" | "withdraw";
  vault: string;
  usdc: TokenRef;
  amount?: AmountInput;
}

export interface PhoenixMarketRef {
  symbol: string;
  /** USD per base unit; "0" when unavailable. */
  markPrice: string;
}

export interface OrderForm {
  kind: "order";
  vault: string;
  markets: PhoenixMarketRef[];
  symbol?: string;
  side: "long" | "short";
  /** Base asset decimal, e.g. "0.5". */
  size?: string;
  type: "market" | "limit";
  slippageBps: number;
  /** Limit price, USD decimal. */
  price?: string;
  postOnly: boolean;
  reduceOnly: boolean;
}

/** Fees and limits of a vault; limits in base units of the deposit token (shares share its decimals). */
export interface VaultParams {
  performanceFeeBps: number;
  managementFeeBps: number;
  depositCap: string;
  minDeposit: string;
  minWithdrawalShares: string;
}

export interface VaultForm {
  kind: "vault";
  /** Set when editing an existing vault; unset when creating one. */
  vault?: string;
  /** A vault the key manages, needed to look up a pasted deposit mint while creating. */
  lookupVault?: string;
  name?: string;
  deposit: PickedToken;
  params: VaultParams;
  /** Editing: the on-chain values, so the update sends only what changed. */
  current?: VaultParams;
}

/** Opens a Jupiter strategy so the vault may hold a token. */
export interface TrackForm {
  kind: "track";
  vault: string;
  deposit: TokenRef;
  token?: PickedToken;
}

export type Form = SwapForm | LpForm | PhoenixTransferForm | OrderForm | VaultForm | TrackForm;


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

function parseSlippageBps(text: string): number {
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, "");
  const bpsMatch = /^(\d+)bps$/.exec(trimmed);
  const percentMatch = /^(\d+(?:\.\d{1,2})?)%?$/.exec(trimmed);
  const bps = bpsMatch ? Number(bpsMatch[1]) : percentMatch ? Math.round(Number(percentMatch[1]) * 100) : Number.NaN;
  if (!Number.isInteger(bps) || bps < 1) throw new InputError('Send slippage as a percent like "0.8" or as "80bps".');
  return bps;
}

/** "0.8", "0.8%", or "80bps" → basis points, capped by the protocol. */
export function parseSlippage(text: string): number {
  const bps = parseSlippageBps(text);
  if (bps > MAX_SLIPPAGE_BPS) throw new InputError(`The protocol caps slippage at ${MAX_SLIPPAGE_BPS / 100}%.`);
  return bps;
}

/** Slippage for a Phoenix market order, which allows more room than a swap. */
export function parseOrderSlippage(text: string): number {
  const bps = parseSlippageBps(text);
  if (bps > MAX_ORDER_SLIPPAGE_BPS) throw new InputError(`Phoenix market orders allow at most ${MAX_ORDER_SLIPPAGE_BPS / 100}% slippage.`);
  return bps;
}

/** A fee typed as a percent ("2", "2.5%") → basis points, 0..10000. Exact: no floating point. */
export function parseFeeBps(text: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!match) throw new InputError('Send a fee as a percent like "2" or "0.5%" (at most 2 decimals).');
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > 10_000) throw new InputError("A fee must be between 0% and 100%.");
  return bps;
}

/** A positive decimal string as Phoenix takes it ("0.5", "142.25"), at most 12 decimals. */
export function parseDecimal(text: string, what: string): string {
  const trimmed = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,12})?$/.test(trimmed) || !/[1-9]/.test(trimmed)) {
    throw new InputError(`Send the ${what} as a positive number like "142.5", with at most 12 decimals.`);
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

/** Vault names are stored on chain in at most 32 UTF-8 bytes; emoji take 4. */
export function parseVaultName(text: string): string {
  const name = text.trim();
  if (!name) throw new InputError("Send a name for the vault.");
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes > MAX_VAULT_NAME_BYTES) throw new InputError(`That name is ${bytes} bytes; the limit is ${MAX_VAULT_NAME_BYTES}. Use a shorter name.`);
  return name;
}

/** A vault limit in display units → base units. `allowNone` accepts "none" for a cap that never binds. */
export function parseLimit(text: string, decimals: number, allowNone = false): string {
  const trimmed = text.trim().toLowerCase();
  if (allowNone && (trimmed === "none" || trimmed === "no cap")) return NO_DEPOSIT_CAP;
  let baseUnits: string;
  try {
    baseUnits = parseUnits(trimmed, decimals);
  } catch (error) {
    throw new InputError(`${error instanceof Error ? error.message : "Not an amount"}. Send an amount like "1000"${allowNone ? ', or "none" for no cap' : ""}.`);
  }
  if (BigInt(baseUnits) > BigInt(NO_DEPOSIT_CAP)) throw new InputError("That amount is too large.");
  if (!allowNone && baseUnits === "0") throw new InputError("This minimum must be more than zero.");
  return baseUnits;
}

export function parsePrice(text: string): number {
  const price = Number(text.trim().replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) throw new InputError('Send a positive price like "142.5".');
  return price;
}

export interface BinAmounts {
  binId: number;
  amountX: string;
  amountY: string;
}

/** Remove quick picks: a share of the position's width from its highest-price (top) or lowest-price (bottom) end. */
export const QUICK_PICKS = [
  { bins: "top25", end: "top", pct: 25, label: "top 25% of bins", button: "⏫ Top 25% of bins" },
  { bins: "top50", end: "top", pct: 50, label: "top 50% of bins", button: "⏫ Top 50% of bins" },
  { bins: "bottom25", end: "bottom", pct: 25, label: "bottom 25% of bins", button: "⏬ Bottom 25% of bins" },
  { bins: "bottom50", end: "bottom", pct: 50, label: "bottom 50% of bins", button: "⏬ Bottom 50% of bins" },
] as const;
export type QuickPick = (typeof QUICK_PICKS)[number];

/** ceil(width × pct) bins, at least 1, from one end of the position, regardless of the active bin. */
export function quickPickRange(position: InclusiveBinRange, end: QuickPick["end"], pct: number): InclusiveBinRange {
  const width = position.upperBinId - position.lowerBinId + 1;
  const count = Math.max(1, Math.ceil((width * pct) / 100));
  return end === "top"
    ? { lowerBinId: position.upperBinId - count + 1, upperBinId: position.upperBinId }
    : { lowerBinId: position.lowerBinId, upperBinId: position.lowerBinId + count - 1 };
}

/** Per-bin amounts in `range` at `bps`, each bin floored, like the app's `amountsInSelection`. */
export function amountsInRange(bins: readonly BinAmounts[], range: InclusiveBinRange, bps: number): { amountX: bigint; amountY: bigint } {
  let amountX = 0n;
  let amountY = 0n;
  for (const b of bins) {
    if (b.binId < range.lowerBinId || b.binId > range.upperBinId) continue;
    amountX += (BigInt(b.amountX) * BigInt(bps)) / 10_000n;
    amountY += (BigInt(b.amountY) * BigInt(bps)) / 10_000n;
  }
  return { amountX, amountY };
}

export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function swapTokens(form: SwapForm): { input: TokenRef; output: TokenRef } | undefined {
  if (!form.token || !form.side) return undefined;
  return form.side === "buy" ? { input: form.deposit, output: form.token } : { input: form.token, output: form.deposit };
}

export const describeAmount = (input: AmountInput | undefined, token: TokenRef | undefined, format: (base: string, decimals: number) => string) =>
  !input ? "not set" : input.kind === "share" ? (input.bps === 10_000 ? "max" : `${input.bps / 100}% of balance`) : `${format(input.baseUnits, token?.decimals ?? 0)} ${token?.symbol ?? ""}`.trim();

export interface FormDeps {
  api: HedgeClient;
  forms: IdStore<Form>;
  actions: IdStore<PendingAction>;
}

/** After a button: show a screen, or ask the user to type a field. */
export type FormResult = { kind: "show"; screen: Screen } | { kind: "ask"; field: TextField; prompt: string };

const SHAPE_LABEL: Record<DlmmShape, string> = { spot: "Spot", curve: "Curve", bidAsk: "Bid-Ask" };
export const shapeLabel = (shape: DlmmShape) => SHAPE_LABEL[shape];

/**
 * What the vault can spend now: tokens in its own token accounts. `getHoldings` totals also count
 * tokens inside LP positions, fees, and Phoenix, which a deposit or swap cannot move.
 */
const idleBalanceOf = (vault: VaultDetail, mint: string) =>
  mint === vault.depositMint ? vault.idleBalance : vault.unmanagedHoldings.find((h) => h.token.mint === mint)?.amount ?? "0";
const tokenRef = ({ mint, symbol, decimals }: TokenRef): TokenRef => ({ mint, symbol, decimals });
export const fmt = (baseUnits: string, token: TokenRef) => `${formatUnits(baseUnits, token.decimals)} ${token.symbol}`;

export async function createSwapForm(api: HedgeClient, vault: string): Promise<SwapForm> {
  const holdings = await api.getHoldings(vault);
  const deposit = tokenRef(holdings.depositToken);
  const held = holdings.tokens
    .filter((t) => t.token.mint !== deposit.mint)
    .slice(0, SWAP_PICKER_TOKENS)
    .map((t) => ({ ...tokenRef(t.token), pasted: false, verified: null }));
  return { kind: "swap", vault, deposit, slippageBps: SLIPPAGE_PRESETS[0], held };
}

export async function createPhoenixTransferForm(api: HedgeClient, vault: string, direction: PhoenixTransferForm["direction"]): Promise<PhoenixTransferForm> {
  const phoenix = await api.getPhoenix(vault);
  if (phoenix.status !== "ready") throw new ScreenNotice("Finish Phoenix setup first: open 📈 Phoenix.");
  const holdings = await api.getHoldings(vault);
  return { kind: "phoenixTransfer", direction, vault, usdc: tokenRef(holdings.depositToken) };
}

export async function createOrderForm(api: HedgeClient, vault: string): Promise<OrderForm> {
  const phoenix = await api.getPhoenix(vault);
  if (phoenix.status !== "ready") throw new ScreenNotice("Finish Phoenix setup first: open 📈 Phoenix.");
  const markets = phoenix.markets.map(({ symbol, markPrice }) => ({ symbol, markPrice }));
  return { kind: "order", vault, markets, side: "long", type: "market", slippageBps: ORDER_SLIPPAGE_PRESETS[1], postOnly: false, reduceOnly: false };
}

const oneUnit = (decimals: number) => (10n ** BigInt(decimals)).toString();
const usdcPick: PickedToken = { ...USDC, pasted: false, verified: true };

export async function createVaultForm(api: HedgeClient, vault?: string): Promise<VaultForm> {
  if (!vault) {
    const [lookup] = await api.listVaults();
    const params = { performanceFeeBps: 0, managementFeeBps: 0, depositCap: NO_DEPOSIT_CAP, minDeposit: oneUnit(USDC.decimals), minWithdrawalShares: oneUnit(USDC.decimals) };
    return { kind: "vault", lookupVault: lookup?.address, deposit: usdcPick, params };
  }
  const detail = await api.getVault(vault);
  const current: VaultParams = {
    performanceFeeBps: detail.performanceFeeBps,
    managementFeeBps: detail.managementFeeBps,
    depositCap: detail.depositCap,
    minDeposit: detail.minDeposit,
    minWithdrawalShares: detail.minWithdrawalShares,
  };
  const deposit = { mint: detail.depositMint, symbol: detail.depositSymbol, decimals: detail.depositDecimals, pasted: false, verified: null };
  return { kind: "vault", vault, name: detail.name, deposit, params: { ...current }, current };
}

export async function createTrackForm(api: HedgeClient, vault: string): Promise<TrackForm> {
  const holdings = await api.getHoldings(vault);
  return { kind: "track", vault, deposit: tokenRef(holdings.depositToken) };
}

/** Only the settings that differ from the vault's, so `vault/update` touches nothing else. */
export function vaultChanges(params: VaultParams, current: VaultParams): VaultChanges {
  const changes: VaultChanges = {};
  if (params.performanceFeeBps !== current.performanceFeeBps) changes.performanceFeeBps = params.performanceFeeBps;
  if (params.managementFeeBps !== current.managementFeeBps) changes.managementFeeBps = params.managementFeeBps;
  if (params.depositCap !== current.depositCap) changes.depositCap = params.depositCap;
  if (params.minDeposit !== current.minDeposit) changes.minDeposit = params.minDeposit;
  if (params.minWithdrawalShares !== current.minWithdrawalShares) changes.minWithdrawalShares = params.minWithdrawalShares;
  return changes;
}

export async function createLpForm(api: HedgeClient, vault: string, position?: { position: string; lbPair: string }): Promise<LpForm> {
  const holdings = await api.getHoldings(vault);
  const form: LpForm = { kind: "lp", mode: position ? "add" : "open", vault, deposit: tokenRef(holdings.depositToken), baseFeePct: null, side: "both", shape: "spot" };
  if (position) {
    form.position = position.position;
    form.pool = await api.getPool(vault, position.lbPair);
  }
  return form;
}

function setPool(form: LpForm, pool: PoolInfo, baseFeePct: number | null): void {
  if (pool.tokenX.mint !== form.deposit.mint && pool.tokenY.mint !== form.deposit.mint) {
    throw new InputError(`That pool does not include the vault's deposit token, ${form.deposit.symbol}.`);
  }
  form.pool = pool;
  form.baseFeePct = baseFeePct;
  form.poolQuery = undefined;
  form.poolChoices = undefined;
  form.amountX = undefined;
  form.amountY = undefined;
  form.side = "both";
  setRange(form, DEFAULT_RANGE_BPS.both);
}

/**
 * Sets min and max from a preset. A one-sided range keeps its near edge 1.5 bins from the
 * active price, so `binRangeForPrices` starts it on the next bin and reports that one side.
 */
function setRange(form: LpForm, bps: number): void {
  if (!form.pool) return;
  const active = Number(form.pool.activePrice);
  const bin = 1 + form.pool.binStep / 10_000;
  form.rangeBps = bps;
  form.minPrice = form.side === "x" ? active * bin ** 1.5 : active * (1 - bps / 10_000);
  form.maxPrice = form.side === "y" ? active * bin ** -1.5 : active * (1 + bps / 10_000);
}

/** Drops the amount of a token the chosen side cannot hold. */
function clearUnholdable(form: LpForm): void {
  if (form.side === "x") form.amountY = undefined;
  if (form.side === "y") form.amountX = undefined;
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
  amountX: 'Send an exact amount like "1.5", or a share like "25%". Send "0" to clear.',
  amountY: 'Send an exact amount like "1.5", or a share like "25%". Send "0" to clear.',
  symbol: 'Send the Phoenix market symbol, e.g. "SOL".',
  size: 'How much of the base asset? Send a size like "0.5".',
  price: 'Send the limit price in USD, e.g. "142.5".',
  orderSlippage: 'Send slippage as a percent like "1" or as "100bps" (max 20%).',
  name: `Send the vault's name (at most ${MAX_VAULT_NAME_BYTES} bytes).`,
  performanceFee: 'Send the performance fee as a percent, e.g. "10" for 10%.',
  managementFee: 'Send the yearly management fee as a percent, e.g. "2" for 2%.',
  depositCap: 'Send the most the vault may hold, in deposit tokens, e.g. "100000". Send "none" for no cap.',
  minDeposit: 'Send the smallest deposit allowed, in deposit tokens, e.g. "10".',
  minWithdrawalShares: 'Send the fewest shares a withdrawal may redeem, e.g. "1".',
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
  const review = async (action: Promise<PendingAction>): Promise<FormResult> => ({ kind: "show", screen: { kind: "confirm", actionId: deps.actions.put(await action) } });
  if (form.kind === "phoenixTransfer") {
    if (op.op === "share") {
      form.amount = { kind: "share", bps: op.bps };
      return show;
    }
    if (op.op === "review") return review(phoenixTransferAction(form, deps.api));
    throw expired();
  }
  if (form.kind === "order") {
    switch (op.op) {
      case "market": {
        const market = form.markets[op.index];
        if (!market) throw expired();
        form.symbol = market.symbol;
        return show;
      }
      case "side":
        form.side = form.side === "long" ? "short" : "long";
        return show;
      case "orderType":
        form.type = form.type === "market" ? "limit" : "market";
        return show;
      case "postOnly":
        form.postOnly = !form.postOnly;
        return show;
      case "reduceOnly":
        form.reduceOnly = !form.reduceOnly;
        return show;
      case "slippage":
        form.slippageBps = op.bps;
        return show;
      case "review":
        return review(Promise.resolve(orderAction(form)));
      default:
        throw expired();
    }
  }
  if (form.kind === "vault") {
    if (op.op === "usdc") {
      setDeposit(form, usdcPick);
      return show;
    }
    if (op.op === "review") return review(Promise.resolve(vaultAction(form)));
    throw expired();
  }
  if (form.kind === "track") {
    if (op.op !== "review") throw expired();
    const token = form.token;
    if (!token) throw new InputError("Paste the token's contract address first.");
    return review(Promise.resolve({ kind: "jupiterInit", vault: form.vault, token: tokenRef(token), verified: token.verified }));
  }
  if (form.kind === "swap") {
    switch (op.op) {
      case "token": {
        const token = form.held[op.index];
        if (!token) throw expired();
        form.token = token;
        return show;
      }
      case "pickToken":
        form.token = undefined;
        form.side = undefined;
        return show;
      case "buy":
      case "sell":
        if (!form.token) throw expired();
        form.side = op.op;
        return show;
      case "share":
        if (!form.side) throw expired();
        form.amount = { kind: "share", bps: op.bps };
        return { kind: "show", screen: { kind: "swapQuote", formId } };
      case "slipMenu":
        form.slippageOpen = true;
        return show;
      case "slippage":
        form.slippageBps = op.bps;
        form.slippageOpen = false;
        return show;
      case "back":
        if (form.slippageOpen) form.slippageOpen = false;
        else form.side = undefined;
        return show;
      default:
        throw expired();
    }
  }
  switch (op.op) {
    case "shape": {
      const shape = SHAPES[op.index];
      if (!shape) throw expired();
      form.shape = shape;
      return show;
    }
    case "amountPick": {
      if (!form.pool) throw new InputError("Pick a pool first.");
      form.picking = op.index === 0 ? "amountX" : op.index === 1 ? "amountY" : undefined;
      return show;
    }
    case "share": {
      if (!form.picking) throw expired();
      if (form.picking === "amountX") form.amountX = { kind: "share", bps: op.bps };
      else form.amountY = { kind: "share", bps: op.bps };
      form.picking = undefined;
      return show;
    }
    case "lpSide": {
      const side = LP_SIDES[op.index];
      if (!side || form.mode !== "open") throw expired();
      if (!form.pool) throw new InputError("Pick a pool first.");
      form.side = side;
      setRange(form, DEFAULT_RANGE_BPS[side]);
      clearUnholdable(form);
      return show;
    }
    case "pool": {
      const choice = form.poolChoices?.[op.index];
      if (!choice) throw expired();
      setPool(form, await deps.api.getPool(form.vault, choice.address), choice.baseFeePct);
      return show;
    }
    case "range":
      if (!form.pool) throw new InputError("Pick a pool first.");
      setRange(form, op.bps);
      return show;
    case "review":
      return review(lpAction(form, deps.api));
    case "empty":
      return review(Promise.resolve(emptyPositionAction(form)));
    default:
      throw expired();
  }
}

function setDeposit(form: VaultForm, token: PickedToken): void {
  form.deposit = token;
  // Limits are in the deposit token's units, so a new token resets them to one whole unit.
  form.params.minDeposit = oneUnit(token.decimals);
  form.params.minWithdrawalShares = oneUnit(token.decimals);
  form.params.depositCap = NO_DEPOSIT_CAP;
}

async function pasteMint(api: HedgeClient, lookupVault: string, text: string): Promise<PickedToken> {
  const mint = text.trim();
  if (!BASE58_ADDRESS.test(mint)) throw new InputError("That is not a Solana address. Paste the token's mint address.");
  const detail = await api.getToken(lookupVault, mint);
  return { ...tokenRef(detail), pasted: true, verified: detail.verified };
}

/** Applies a typed answer. Returns the screen to show next when it is not the form itself. */
export async function applyFormText(formId: string, field: TextField, text: string, deps: FormDeps): Promise<Screen | undefined> {
  const form = getForm(deps, formId);
  if (form.kind === "phoenixTransfer") {
    if (field !== "amount") throw expired();
    form.amount = parseAmountInput(text, form.usdc.decimals);
    return;
  }
  if (form.kind === "order") {
    switch (field) {
      case "symbol": {
        const market = form.markets.find((m) => m.symbol.toLowerCase() === text.trim().toLowerCase());
        if (!market) throw new InputError(`Phoenix has no "${text.trim()}" market.`);
        form.symbol = market.symbol;
        return;
      }
      case "size":
        form.size = parseDecimal(text, "size");
        return;
      case "price":
        form.price = parseDecimal(text, "price");
        return;
      case "orderSlippage":
        form.slippageBps = parseOrderSlippage(text);
        return;
      default:
        throw expired();
    }
  }
  if (form.kind === "vault") {
    const { decimals } = form.deposit;
    switch (field) {
      case "name":
        if (form.vault) throw expired();
        form.name = parseVaultName(text);
        return;
      case "token": {
        if (form.vault) throw expired();
        if (!form.lookupVault) throw new InputError("The bot can look up a pasted token only once your key manages a vault. Create this one in USDC.");
        setDeposit(form, await pasteMint(deps.api, form.lookupVault, text));
        return;
      }
      case "performanceFee":
        form.params.performanceFeeBps = parseFeeBps(text);
        return;
      case "managementFee":
        form.params.managementFeeBps = parseFeeBps(text);
        return;
      case "depositCap":
        form.params.depositCap = parseLimit(text, decimals, true);
        return;
      case "minDeposit":
        form.params.minDeposit = parseLimit(text, decimals);
        return;
      case "minWithdrawalShares":
        form.params.minWithdrawalShares = parseLimit(text, decimals);
        return;
      default:
        throw expired();
    }
  }
  if (form.kind === "track") {
    if (field !== "token") throw expired();
    const token = await pasteMint(deps.api, form.vault, text);
    if (token.mint === form.deposit.mint) throw new InputError(`That is the deposit token, ${form.deposit.symbol}. The vault always holds it.`);
    form.token = token;
    return;
  }
  if (form.kind === "swap") {
    switch (field) {
      case "token": {
        const mint = text.trim();
        if (!BASE58_ADDRESS.test(mint)) throw new InputError("That is not a Solana address. Paste the token's mint address.");
        if (mint === form.deposit.mint) throw new InputError(`That is the deposit token, ${form.deposit.symbol}. Paste the other token.`);
        const detail = await deps.api.getToken(form.vault, mint);
        form.token = { ...tokenRef(detail), pasted: true, verified: detail.verified };
        return;
      }
      case "amount": {
        const { input } = swapTokens(form) ?? {};
        if (!input) throw expired();
        const amount = parseAmountInput(text, input.decimals);
        // Check the balance here so a bad amount re-asks instead of failing the quote.
        if (resolveAmount(amount, idleBalanceOf(await deps.api.getVault(form.vault), input.mint)) === "0") throw new InputError(`The vault holds no ${input.symbol}.`);
        form.amount = amount;
        return { kind: "swapQuote", formId };
      }
      case "slippage":
        form.slippageBps = parseSlippage(text);
        form.slippageOpen = false;
        return;
      default:
        throw expired();
    }
  }
  switch (field) {
    case "pool": {
      const query = text.trim();
      if (BASE58_ADDRESS.test(query)) {
        setPool(form, await deps.api.getPool(form.vault, query), null);
        return;
      }
      const { pools } = await deps.api.searchPools(form.vault, query);
      const eligible = pools.filter((p) => p.tokenX.mint === form.deposit.mint || p.tokenY.mint === form.deposit.mint);
      if (eligible.length === 0) throw new InputError(`No pool matching "${query}" pairs with ${form.deposit.symbol}.`);
      form.poolQuery = query;
      form.poolChoices = eligible
        .map((p) => ({
          address: p.address,
          pair: `${p.tokenX.symbol}/${p.tokenY.symbol}`,
          binStep: p.binStep,
          baseFeePct: p.baseFeePct ?? null,
          tvl: p.tvl ?? null,
          volume24h: p.volume24h ?? null,
        }))
        .sort((a, b) => (b.tvl ?? -1) - (a.tvl ?? -1))
        .slice(0, 6);
      return;
    }
    case "minPrice":
    case "maxPrice": {
      const price = parsePrice(text);
      if (field === "minPrice") form.minPrice = price;
      else form.maxPrice = price;
      form.rangeBps = undefined;
      // A typed range picks its own side; follow it so the side buttons and amounts match.
      const range = formRange(form);
      if (typeof range !== "string") {
        form.side = range.sides;
        clearUnholdable(form);
      }
      return;
    }
    case "amountX":
    case "amountY": {
      if (!form.pool) throw new InputError("Pick a pool first.");
      const token = field === "amountX" ? form.pool.tokenX : form.pool.tokenY;
      const value = text.trim() === "0" ? undefined : parseAmountInput(text, token.decimals);
      if (field === "amountX") form.amountX = value;
      else form.amountY = value;
      form.picking = undefined;
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
  const vault = await api.getVault(form.vault);
  const amountX = form.amountX ? resolveAmount(form.amountX, idleBalanceOf(vault, pool.tokenX.mint)) : "0";
  const amountY = form.amountY ? resolveAmount(form.amountY, idleBalanceOf(vault, pool.tokenY.mint)) : "0";
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

function emptyPositionAction(form: LpForm): PendingAction {
  const pool = form.pool;
  if (!pool || form.mode !== "open") throw new InputError("Pick a pool first.");
  const range = formRange(form);
  if (typeof range === "string") throw new InputError(range);
  if (range.binCount > MAX_EMPTY_POSITION_BINS) {
    throw new InputError(`An empty position can span at most ${MAX_EMPTY_POSITION_BINS} bins; this range has ${range.binCount}. Narrow it.`);
  }
  return {
    kind: "dlmmInit",
    vault: form.vault,
    lbPair: pool.lbPair,
    pairLabel: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
    lowerBinId: range.lowerBinId,
    upperBinId: range.upperBinId,
    priceRange: { low: formatPrice(range.lowPrice), high: formatPrice(range.highPrice) },
  };
}

async function phoenixTransferAction(form: PhoenixTransferForm, api: HedgeClient): Promise<PendingAction> {
  if (!form.amount) throw new InputError("Set an amount first.");
  let balance: string;
  if (form.direction === "deposit") balance = idleBalanceOf(await api.getVault(form.vault), form.usdc.mint);
  else {
    const phoenix = await api.getPhoenix(form.vault);
    const withdrawable = phoenix.account?.withdrawable ?? phoenix.withdrawable;
    if (withdrawable === null) {
      if (form.amount.kind === "share") throw new InputError("Phoenix did not report a withdrawable amount just now. Type an exact amount.");
      balance = form.amount.baseUnits;
    } else balance = withdrawable.startsWith("-") ? "0" : withdrawable;
  }
  const amountBaseUnits = resolveAmount(form.amount, balance);
  if (amountBaseUnits === "0") throw new InputError(form.direction === "deposit" ? "The vault holds no idle USDC." : "Nothing is withdrawable from Phoenix right now.");
  return form.direction === "deposit" ? { kind: "phoenixDeposit", vault: form.vault, amountBaseUnits } : { kind: "phoenixWithdraw", vault: form.vault, amountBaseUnits };
}

function orderAction(form: OrderForm): PendingAction {
  if (!form.symbol) throw new InputError("Pick a market first.");
  if (!form.size) throw new InputError("Set a size first.");
  let order: Extract<PendingAction, { kind: "phoenixOrder" }>["order"]["order"];
  if (form.type === "market") order = { type: "market", slippageBps: form.slippageBps };
  else {
    if (!form.price) throw new InputError("Set a limit price first.");
    order = { type: "limit", price: form.price, postOnly: form.postOnly };
  }
  return { kind: "phoenixOrder", vault: form.vault, order: { symbol: form.symbol, side: form.side, size: form.size, reduceOnly: form.reduceOnly, order } };
}

function vaultAction(form: VaultForm): PendingAction {
  const deposit = tokenRef(form.deposit);
  if (form.vault) {
    if (!form.current) throw expired();
    const changes = vaultChanges(form.params, form.current);
    if (Object.keys(changes).length === 0) throw new InputError("Change at least one setting first.");
    return { kind: "vaultUpdate", vault: form.vault, deposit, changes };
  }
  if (!form.name) throw new InputError("Name the vault first.");
  return { kind: "vaultCreate", name: form.name, deposit, ...form.params };
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "?";
  return price >= 1 ? price.toLocaleString("en-US", { maximumFractionDigits: 4 }) : price.toPrecision(4);
}

export async function renderForm(formId: string, deps: FormDeps): Promise<RenderedScreen> {
  const form = getForm(deps, formId);
  switch (form.kind) {
    case "swap":
      return renderSwapForm(formId, form, await deps.api.getVault(form.vault), deps);
    case "lp":
      return renderLpForm(formId, form, await deps.api.getVault(form.vault));
    case "phoenixTransfer":
      return renderPhoenixTransferForm(formId, form);
    case "order":
      return renderOrderForm(formId, form);
    case "vault":
      return renderVaultForm(formId, form);
    case "track":
      return renderTrackForm(formId, form);
  }
}

const check = (on: boolean) => (on ? "✓ " : "");

function renderPhoenixTransferForm(formId: string, form: PhoenixTransferForm): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const rows: Button[][] = [
    [
      ...[2500, 5000, 10_000].map((bps) => op(`${check(form.amount?.kind === "share" && form.amount.bps === bps)}${bps === 10_000 ? "Max" : `${bps / 100}%`}`, { op: "share", bps })),
      op("✏️ Amount", { op: "ask", field: "amount" }),
    ],
  ];
  if (form.amount) rows.push([op("✅ Review", { op: "review" })]);
  rows.push([button("⬅️ Phoenix", { kind: "phoenix", vault: form.vault })]);
  return { html: phoenixTransferFormMessage(form), keyboard: keyboard(rows) };
}

function renderOrderForm(formId: string, form: OrderForm): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const marketButtons = form.markets.slice(0, MAX_MARKET_BUTTONS).map((m, index) => op(`${check(form.symbol === m.symbol)}${m.symbol}`, { op: "market", index }));
  const rows: Button[][] = [];
  for (let i = 0; i < marketButtons.length; i += 4) rows.push(marketButtons.slice(i, i + 4));
  rows.push(
    [op("✏️ Market", { op: "ask", field: "symbol" }), op("✏️ Size", { op: "ask", field: "size" })],
    [op(form.side === "long" ? "🟢 Long · tap for short" : "🔴 Short · tap for long", { op: "side" })],
    [op(form.type === "market" ? "⚡ Market order · tap for limit" : "📌 Limit order · tap for market", { op: "orderType" })],
  );
  if (form.type === "market") {
    rows.push([
      ...ORDER_SLIPPAGE_PRESETS.map((bps) => op(`${check(form.slippageBps === bps)}${bps / 100}%`, { op: "slippage", bps })),
      op(ORDER_SLIPPAGE_PRESETS.includes(form.slippageBps as (typeof ORDER_SLIPPAGE_PRESETS)[number]) ? "✏️ Slippage" : `✓ ${form.slippageBps / 100}% ✏️`, { op: "ask", field: "orderSlippage" }),
    ]);
  } else {
    rows.push([op("✏️ Limit price", { op: "ask", field: "price" }), op(`Post-only: ${form.postOnly ? "on" : "off"}`, { op: "postOnly" })]);
  }
  rows.push([op(`↩️ Reduce-only: ${form.reduceOnly ? "on" : "off"}`, { op: "reduceOnly" })]);
  if (form.symbol && form.size && (form.type === "market" || form.price)) rows.push([op("✅ Review", { op: "review" })]);
  rows.push([button("⬅️ Phoenix", { kind: "phoenix", vault: form.vault })]);
  return { html: orderFormMessage(form), keyboard: keyboard(rows) };
}

function renderVaultForm(formId: string, form: VaultForm): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const rows: Button[][] = [];
  if (!form.vault) {
    rows.push([op("✏️ Name", { op: "ask", field: "name" })]);
    rows.push([op(`${check(form.deposit.mint === USDC.mint)}USDC`, { op: "usdc" }), op("📋 Paste deposit mint", { op: "ask", field: "token" })]);
  }
  rows.push(
    [op("✏️ Performance fee", { op: "ask", field: "performanceFee" }), op("✏️ Management fee", { op: "ask", field: "managementFee" })],
    [op("✏️ Deposit cap", { op: "ask", field: "depositCap" }), op("✏️ Min deposit", { op: "ask", field: "minDeposit" })],
    [op("✏️ Min withdrawal shares", { op: "ask", field: "minWithdrawalShares" })],
  );
  if (form.vault ? form.current && Object.keys(vaultChanges(form.params, form.current)).length > 0 : form.name) rows.push([op("✅ Review", { op: "review" })]);
  rows.push([form.vault ? button("⬅️ Settings", { kind: "settings", vault: form.vault }) : button("🏦 Vaults", { kind: "vaults" })]);
  return { html: vaultFormMessage(form), keyboard: keyboard(rows) };
}

function renderTrackForm(formId: string, form: TrackForm): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const rows: Button[][] = [[op("📋 Paste CA", { op: "ask", field: "token" })]];
  if (form.token) rows.push([op("✅ Review", { op: "review" })]);
  rows.push([button("⬅️ Strategies", { kind: "strategies", vault: form.vault })]);
  return { html: trackFormMessage(form), keyboard: keyboard(rows) };
}

function renderSwapForm(formId: string, form: SwapForm, vault: VaultDetail, deps: FormDeps): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const toVault = button("⬅️ Vault", { kind: "vault", vault: form.vault });
  const back = op("⬅️ Back", { op: "back" });
  if (!form.token) {
    const balances = form.held.map((token) => idleBalanceOf(vault, token.mint));
    // Three buttons per row at most: Telegram cuts labels short on phones past that.
    const rows = rowsOf([...form.held.map((token, index) => op(token.symbol, { op: "token", index })), op("📋 Paste CA", { op: "ask", field: "token" })], 3);
    return { html: swapPickerMessage(form, balances), keyboard: keyboard([...rows, [toVault]]) };
  }
  if (form.slippageOpen) {
    const presets = SLIPPAGE_PRESETS.map((bps) => op(`${form.slippageBps === bps ? "✓ " : ""}${bps / 100}%`, { op: "slippage", bps }));
    return { html: swapSlippageMessage(form.slippageBps), keyboard: keyboard([presets, [op("✏️ Type", { op: "ask", field: "slippage" }), back]]) };
  }
  const tokens = swapTokens(form);
  if (form.side && tokens) {
    const balance = idleBalanceOf(vault, tokens.input.mint);
    const presets = SWAP_AMOUNT_PRESETS.map((bps) => op(bps === 10_000 ? "Max" : `${bps / 100}%`, { op: "share", bps }));
    return {
      html: swapAmountMessage(form.side, tokens, balance, SWAP_AMOUNT_PRESETS, form.slippageBps),
      keyboard: keyboard([presets, [op("✏️ Type amount", { op: "ask", field: "amount" }), back]]),
    };
  }
  const tokenBalance = idleBalanceOf(vault, form.token.mint);
  const depositBalance = idleBalanceOf(vault, form.deposit.mint);
  const sides = [
    ...(depositBalance === "0" ? [] : [op(`🟢 Buy ${form.token.symbol}`, { op: "buy" })]),
    ...(tokenBalance === "0" ? [] : [op(`🔴 Sell ${form.token.symbol}`, { op: "sell" })]),
  ];
  const rows: Button[][] = [...(sides.length ? [sides] : []), [op(`⚙️ Slippage ${form.slippageBps / 100}%`, { op: "slipMenu" }), op("🔄 Other token", { op: "pickToken" })], [toVault]];
  return { html: swapCardMessage(form.deposit, form.token, tokenBalance, depositBalance), keyboard: keyboard(rows) };
}

/** Share-of-balance shortcuts in the LP amount picker. */
const AMOUNT_SHARES_BPS = [2500, 5000, 7500, 10_000] as const;
const SHAPE_BUTTONS: Record<DlmmShape, [icon: string, text: string]> = { spot: ["▬", "Spot"], curve: ["⛰", "Curve"], bidAsk: ["🔻", "Bid-Ask"] };
/** ✅ takes the icon's place rather than adding width; Telegram cuts long labels on phones. */
const marked = ([icon, text]: [string, string], on: boolean) => `${on ? "✅" : icon} ${text}`;
/** "±5%" around the price, or "+10%" above / "−10%" below it for one side. */
export const rangePresetLabel = (side: LpSide, bps: number) => `${side === "both" ? "±" : side === "x" ? "+" : "−"}${bps / 100}%`;

function renderLpForm(formId: string, form: LpForm, vault: VaultDetail): RenderedScreen {
  const op = (text: string, o: FormOp) => formButton(text, formId, o);
  const pool = form.pool;
  const range = form.mode === "open" ? formRange(form) : undefined;
  const balances = pool ? { x: idleBalanceOf(vault, pool.tokenX.mint), y: idleBalanceOf(vault, pool.tokenY.mint) } : undefined;
  const html = lpFormMessage(form, range, balances);
  const back = button("⬅️ Vault", { kind: "vault", vault: form.vault });
  if (!pool) {
    const choices = (form.poolChoices ?? []).map((choice, index) =>
      op(`${index + 1}. ${choice.pair} · ${choice.baseFeePct === null ? `bin ${choice.binStep}` : feePct(choice.baseFeePct)}`, { op: "pool", index }),
    );
    return { html, keyboard: keyboard([...rowsOf(choices, 1), [op("🏊 Pick pool", { op: "ask", field: "pool" })], [back]]) };
  }
  if (form.picking && balances) {
    const field = form.picking;
    const token = field === "amountX" ? pool.tokenX : pool.tokenY;
    const current = form[field];
    const shares = AMOUNT_SHARES_BPS.map((bps) => {
      const label = `${bps / 100}%`;
      return op(current?.kind === "share" && current.bps === bps ? `✅ ${label}` : label, { op: "share", bps });
    });
    return {
      html: lpAmountMessage(form, token, field === "amountX" ? balances.x : balances.y),
      keyboard: keyboard([shares, [op("✏️ Custom amount", { op: "ask", field })], [op("⬅️ Back", { op: "amountPick", index: 2 })]]),
    };
  }
  const rows: Button[][] = [];
  if (form.mode === "open") {
    const sideButtons: Record<LpSide, [string, string]> = { x: ["💵", `${pool.tokenX.symbol} only`], both: ["⚖️", "Both sides"], y: ["🎯", `${pool.tokenY.symbol} only`] };
    const side = (s: LpSide) => op(marked(sideButtons[s], form.side === s), { op: "lpSide", index: LP_SIDES.indexOf(s) });
    rows.push([side("x"), side("y")], [side("both")]);
  }
  rows.push(SHAPES.map((shape, index) => op(marked(SHAPE_BUTTONS[shape], form.shape === shape), { op: "shape", index })));
  if (form.mode === "open") {
    const presets = RANGE_PRESETS_BPS[form.side].map((bps) => {
      const label = rangePresetLabel(form.side, bps);
      return op(form.rangeBps === bps ? `✅ ${label}` : label, { op: "range", bps });
    });
    rows.push(...rowsOf(presets, 3));
    rows.push([op("✏️ Min price", { op: "ask", field: "minPrice" }), op("✏️ Max price", { op: "ask", field: "maxPrice" })]);
  }
  const validRange = range !== undefined && typeof range !== "string";
  const sides = validRange ? range.sides : "both";
  const amountButtons: Button[] = [];
  if (sides !== "y") amountButtons.push(op(`💧 ${pool.tokenX.symbol} amount`, { op: "amountPick", index: 0 }));
  if (sides !== "x") amountButtons.push(op(`💧 ${pool.tokenY.symbol} amount`, { op: "amountPick", index: 1 }));
  rows.push(amountButtons);
  if ((form.amountX || form.amountY) && (form.mode === "add" || validRange)) rows.push([op("✅ Review", { op: "review" })]);
  if (form.mode === "open") {
    if (validRange) rows.push([op("🫙 Empty position only", { op: "empty" })]);
    rows.push([op("🏊 Change pool", { op: "ask", field: "pool" }), back]);
  } else rows.push([back]);
  return { html, keyboard: keyboard(rows) };
}

/** Quotes the swap form and offers the confirm step. */
export async function renderSwapQuote(formId: string, deps: FormDeps): Promise<RenderedScreen> {
  const form = getForm(deps, formId);
  if (form.kind !== "swap") throw expired();
  const tokens = swapTokens(form);
  if (!tokens || !form.amount || !form.token) throw new ScreenNotice("Pick a token and an amount first.");
  const vault = await deps.api.getVault(form.vault);
  const amountBaseUnits = resolveAmount(form.amount, idleBalanceOf(vault, tokens.input.mint));
  if (amountBaseUnits === "0") throw new InputError(`The vault holds no ${tokens.input.symbol}.`);
  const quote = await deps.api.getQuote({
    vault: form.vault,
    inputMint: tokens.input.mint,
    outputMint: tokens.output.mint,
    amount: amountBaseUnits,
    slippageBps: form.slippageBps,
  });
  const action: PendingAction = {
    kind: "swap",
    vault: form.vault,
    ...tokens,
    amountBaseUnits,
    slippageBps: form.slippageBps,
    unverified: needsWarning(form.token),
  };
  return {
    html: swapQuoteMessage(form, tokens, amountBaseUnits, quote),
    keyboard: keyboard([
      [button(`⚡ Swap ${tokens.input.symbol} → ${tokens.output.symbol}`, { kind: "confirm", actionId: deps.actions.put(action) })],
      [button("🔄 Refresh", { kind: "swapQuote", formId }), button("⬅️ Back", { kind: "form", formId })],
    ]),
  };
}
