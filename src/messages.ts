import {
  DLMM_BINS_PER_TRANSACTION,
  type Holdings,
  type NavHistoryPoint,
  type Outcome,
  type PhoenixManager,
  type PriceRange,
  type Progress,
  type Quote,
  type RequestQueue,
  type Strategy,
  type StrategyHistoryItem,
  type VaultDetail,
  type VaultStatus,
  type VaultSummary,
} from "@hedginvault/sdk";
import type { Liquidity, PendingAction, VaultChanges } from "./actions";
import {
  type AmountInput,
  type LpForm,
  NO_DEPOSIT_CAP,
  type OrderForm,
  type PhoenixTransferForm,
  type SwapForm,
  type TrackForm,
  type VaultForm,
  type VaultParams,
  describeAmount,
  formatPrice,
  needsWarning,
  rangePresetLabel,
  shapeLabel,
  vaultChanges,
} from "./forms";
import type { TokenRef } from "./ui";
import { compactDecimal, compactUnits, compactUsd, feePct, formatBaseUnits, shortAddress } from "./format";

// Telegram counts the limit after parsing entities, so measuring raw HTML is conservative.
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATED = "\n<i>… truncated</i>";

/** Every API-provided value goes through this before it is placed in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Telegram rejects longer messages outright. Cut at a line break: every tag opens and closes
 * on one line, so the result stays valid HTML.
 */
export function fitMessage(html: string): string {
  if (html.length <= TELEGRAM_MESSAGE_LIMIT) return html;
  const room = html.slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATED.length);
  return room.slice(0, room.lastIndexOf("\n")) + TRUNCATED;
}

const amount = (baseUnits: string, decimals: number, symbol: string) =>
  `${formatBaseUnits(baseUnits, decimals)} ${escapeHtml(symbol)}`;
const percent = (bps: number | null) => (bps === null ? "?" : `${(bps / 100).toFixed(2)}%`);
const signedPercent = (bps: number | null) => (bps !== null && bps > 0 ? `+${percent(bps)}` : percent(bps));
const address = (value: string) => `<code>${escapeHtml(value)}</code>`;
const shortSig = (signature: string) => `${signature.slice(0, 6)}…${signature.slice(-4)}`;
const txLink = (signature: string) => `<a href="https://solscan.io/tx/${encodeURIComponent(signature)}">${escapeHtml(shortSig(signature))}</a>`;
const solscanShort = (value: string) => `<a href="https://solscan.io/account/${encodeURIComponent(value)}">${escapeHtml(shortAddress(value))} ↗</a>`;
/** Signed base units (a loss, negative equity) without going through `number`. */
const signedAmount = (baseUnits: string, decimals: number, symbol: string) =>
  baseUnits.startsWith("-") ? `-${amount(baseUnits.slice(1), decimals, symbol)}` : amount(baseUnits, decimals, symbol);
// Phoenix collateral, equity, and margin are USDC base units.
const usdcAmount = (baseUnits: string) => signedAmount(baseUnits, 6, "USDC");
const feePercent = (bps: number) => `${bps / 100}%`;
/** Shares have the deposit token's decimals. */
const shares = (baseUnits: string, decimals: number) => `${formatBaseUnits(baseUnits, decimals)} shares`;
const cap = (baseUnits: string, token: TokenRef) => (baseUnits === NO_DEPOSIT_CAP ? "no cap" : amount(baseUnits, token.decimals, token.symbol));
/** Unix seconds → "2026-10-08 12:00 UTC", the same on every machine. */
const utc = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Prefixes rows with tree branches so related facts stack vertically under a heading. */
const tree = (rows: string[]) => rows.map((row, index) => `${index === rows.length - 1 ? "└" : "├"} ${row}`);
const BAR_CELLS = 10;
const barCells = (bps: number) => {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((bps * BAR_CELLS) / 10_000)));
  return `${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}`;
};
/** A 10-cell share bar in monospace so bars line up; null shares get no bar. */
const bar = (bps: number | null) => (bps === null ? "" : `<code>${barCells(bps)}</code>`);
/** Separates the parts of a receipt-style screen. */
const DIVIDER = "━━━━━━━━━━━━";
/** Short amount with its symbol, for lists. */
const compact = (baseUnits: string, decimals: number, symbol: string) => `${compactUnits(baseUnits, decimals)} ${escapeHtml(symbol)}`;
/** An API price string trimmed for display. */
const price = (value: string) => escapeHtml(compactDecimal(value));
const shareText = (bps: number) => `${(bps / 100).toFixed(1)}%`;

const GAUGE_CELLS = 10;
/**
 * A price range as a track with the price on it: `├───●──────┤`. Out of range, an arrow sits
 * on the edge the price left from. Display only, so plain numbers are fine.
 */
export function rangeGauge(lower: number, active: number, upper: number): string {
  const cells = Array.from({ length: GAUGE_CELLS }, () => "─");
  if (Number.isFinite(lower) && Number.isFinite(active) && Number.isFinite(upper) && upper > lower) {
    if (active < lower) cells[0] = "◀";
    else if (active > upper) cells[GAUGE_CELLS - 1] = "▶";
    else cells[Math.round(((active - lower) / (upper - lower)) * (GAUGE_CELLS - 1))] = "●";
  }
  return `├${cells.join("")}┤`;
}

type DlmmStrategy = Extract<Strategy, { type: "dlmm" }>;
/** Display only: compares the API's decimal price strings as numbers. */
const inRange = (s: DlmmStrategy) => Number(s.lowerPrice) <= Number(s.activePrice) && Number(s.activePrice) <= Number(s.upperPrice);
const rangeStatus = (s: DlmmStrategy) => (inRange(s) ? "🟢 in range" : "🟠 out of range");
/** Where the price sits: inside the range (with how far through it), or which side it left by. */
function rangePlace(s: DlmmStrategy): string {
  const [lower, active, upper] = [Number(s.lowerPrice), Number(s.activePrice), Number(s.upperPrice)];
  if (active < lower) return "🟠 <b>Out of range</b> · price below your range";
  if (active > upper) return "🟠 <b>Out of range</b> · price above your range";
  const through = upper > lower ? Math.round(((active - lower) / (upper - lower)) * 100) : 0;
  return `🟢 <b>In range</b> · ${through}% through`;
}
const gaugeLine = (s: DlmmStrategy) =>
  `<code>${price(s.lowerPrice)} ${rangeGauge(Number(s.lowerPrice), Number(s.activePrice), Number(s.upperPrice))} ${price(s.upperPrice)}</code>`;
/** USD of a base-unit amount; null when the token has no price. Display only. */
const tokenUsd = (baseUnits: string, token: { decimals: number; priceUsd?: number | null }) =>
  baseUnits === "0" ? 0 : token.priceUsd == null ? null : (Number(baseUnits) / 10 ** token.decimals) * token.priceUsd;
const sumUsd = (parts: (number | null)[]) => (parts.some((part) => part === null) ? null : parts.reduce<number>((total, part) => total + (part ?? 0), 0));
const lpValueUsd = (s: DlmmStrategy) => sumUsd([tokenUsd(s.amountX, s.tokenX), tokenUsd(s.amountY, s.tokenY)]);
const lpFeesUsd = (s: DlmmStrategy) => sumUsd([tokenUsd(s.pendingFeeX, s.tokenX), tokenUsd(s.pendingFeeY, s.tokenY)]);
const signedUsd = (value: number) => `${value < 0 ? "-" : value > 0 ? "+" : ""}${compactUsd(Math.abs(value))}`;
/** "🔴 -$0.12 (-4.51%)", or undefined when Meteora reported no PnL. */
const lpPnl = (s: DlmmStrategy) =>
  s.pnlUsd == null ? undefined : `${signIcon(s.pnlUsd)} ${signedUsd(s.pnlUsd)}${s.pnlPct == null ? "" : ` (${s.pnlPct > 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%)`}`;
const pair = (x: TokenRef, y: TokenRef) => `${escapeHtml(x.symbol)}/${escapeHtml(y.symbol)}`;
const leverage = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(2)}x`);
const SPARK = "▁▂▃▄▅▆▇█";
/** One block per value, scaled between the smallest and largest, oldest first. */
const sparkline = (values: bigint[]) => {
  const min = values.reduce((low, value) => (value < low ? value : low));
  const max = values.reduce((high, value) => (value > high ? value : high));
  const span = max - min;
  return values.map((value) => SPARK[span === 0n ? 3 : Number(((value - min) * 7n) / span)]).join("");
};
const signIcon = (sign: bigint | number) => (sign > 0 ? "🟢" : sign < 0 ? "🔴" : "⚪");
/** Percent change with 4 decimals, computed in bigint parts per million of `from`. */
const changePercent = (fromBaseUnits: string, toBaseUnits: string) => {
  const from = BigInt(fromBaseUnits);
  if (from === 0n) return null;
  const diff = BigInt(toBaseUnits) - from;
  const abs = ((diff < 0n ? -diff : diff) * 1_000_000n) / from;
  // The sign comes from the raw difference so a drop under 0.0001% still reads as a drop.
  return { sign: diff, text: `${diff < 0n ? "-" : diff > 0n ? "+" : ""}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, "0")}%` };
};
/** Seconds → "3d 4h", "4h 6m", or "12m". */
const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const STATUS_LABEL: Record<string, string> = {
  normal: "🟢 normal",
  reduceOnly: "🟡 reduce only",
  paused: "🔴 paused",
};
const status = (value: string) => STATUS_LABEL[value] ?? `⚪ ${escapeHtml(value)}`;

export const HELP_MESSAGE = [
  "🤖 <b>Hedge Vault manager bot</b>",
  "",
  "Add your manager wallet under 👛 <b>Wallet</b> (import its private key, or create a new one), add the API key an admin issued for it, then tap <b>Vaults</b>.",
  "",
  "<b>Swap</b> · Vault → 💱 Swap. Pick a held token or paste any token's contract address, then set the amount (\"1.5\", \"25%\", \"max\") and slippage.",
  "<b>LP</b> · Vault → ➕ New LP. Paste a pool or search by symbol, pick a side, shape, and range, and size each token.",
  "",
  "<b>Commands</b>",
  "/vaults · vaults your active wallet manages",
  "/wallet · import, create, export, or switch wallets",
  "/holdings &lt;vault&gt; · vault overview: value, tokens, positions",
  "/strategies &lt;vault&gt; · open strategies",
  "/nav &lt;vault&gt; · last posted NAVs",
  "/requests &lt;vault&gt; · queued deposits and withdrawals",
  "/history &lt;vault&gt; · closed strategies",
  "/phoenix &lt;vault&gt; · Phoenix perps: setup, margin, orders",
  "/settings &lt;vault&gt; · fees, limits, status, pauses",
  "/cancel · stop typing into a form",
  "",
  "• &lt;vault&gt; is a number from /vaults, an address, or a vault name.",
  "• Tap an address to copy it.",
  "• Form and confirm buttons stop working when the bot restarts. Send /start for fresh ones.",
].join("\n");

export function vaultsMessage(vaults: VaultSummary[]): string {
  if (vaults.length === 0) return "🏦 This API key has no vaults in scope.";
  const blocks = vaults.map((vault, index) =>
    [
      `<b>${index + 1}. ${escapeHtml(vault.name)}</b> · ${status(vault.status)}`,
      `└ <b>${compact(vault.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b> · ${solscanShort(vault.address)}`,
    ].join("\n"),
  );
  return [`🏦 <b>Your vaults</b> (${vaults.length})`, ...blocks].join("\n\n");
}

const SYMBOL_COLUMN_MAX = 6;
const clipSymbol = (symbol: string) => {
  const chars = [...symbol];
  return chars.length > SYMBOL_COLUMN_MAX ? `${chars.slice(0, SYMBOL_COLUMN_MAX - 1).join("")}…` : symbol;
};

/** One aligned monospace row per token, largest share first. */
function tokenRows(tokens: Holdings["tokens"]): string[] {
  const sorted = [...tokens].sort((a, b) => (b.shareBps ?? -1) - (a.shareBps ?? -1));
  const symbols = sorted.map((t) => clipSymbol(t.token.symbol));
  const symbolWidth = Math.max(0, ...symbols.map((symbol) => [...symbol].length));
  const shares = sorted.map((t) => (t.shareBps === null ? "?" : shareText(t.shareBps)));
  const shareWidth = Math.max(0, ...shares.map((share) => share.length));
  return sorted.map((t, index) => {
    const symbol = symbols[index] ?? "";
    const cells = t.shareBps === null ? " ".repeat(BAR_CELLS) : barCells(t.shareBps);
    const column = `${escapeHtml(symbol + " ".repeat(symbolWidth - [...symbol].length))} ${cells} ${(shares[index] ?? "").padStart(shareWidth)}`;
    return `<code>${column}</code> ${compactUnits(t.amount, t.token.decimals)} · ${t.usd === null ? "no price" : compactUsd(t.usd)}`;
  });
}

/** Open LP and perps positions; swap strategies already show up as tokens. */
function positionRows(strategies: Strategy[]): string[] {
  return strategies.flatMap((s) => {
    switch (s.type) {
      case "dlmm": {
        const value = lpValueUsd(s);
        const fees = lpFeesUsd(s);
        const pnl = lpPnl(s);
        const facts = [
          value === null ? `${compact(s.amountX, s.tokenX.decimals, s.tokenX.symbol)} + ${compact(s.amountY, s.tokenY.decimals, s.tokenY.symbol)}` : compactUsd(value),
          ...(pnl ? [`PnL ${pnl}`] : []),
          ...(fees === null ? [] : [`fees ${compactUsd(fees)}`]),
        ];
        return [`🌊 <b>${pair(s.tokenX, s.tokenY)}</b> LP · ${rangeStatus(s)}`, `${gaugeLine(s)} now ${price(s.activePrice)}`, `└ ${facts.join(" · ")}`];
      }
      case "phoenix":
        // Phoenix equity is in USDC atoms (6 decimals).
        return [`📈 <b>Perps</b> · ${compact(s.equity, 6, "USDC")} equity · ${s.leverage === null ? "leverage n/a" : leverage(s.leverage)}`];
      case "unreadable":
        return [`⚠️ Unreadable ${escapeHtml(s.protocol)} strategy`];
      case "jupiter":
        return [];
    }
  });
}

/** The vault home screen: value, token mix, and open positions. */
/** `holdings` or `strategies` is undefined when that read failed, so the menu still opens. */
export function vaultMessage(vault: VaultSummary, holdings: Holdings | undefined, strategies: Strategy[] | undefined): string {
  const title = [`🏦 <b>${escapeHtml(vault.name)}</b> · ${status(vault.status)}`, address(vault.address), ""];
  if (!holdings) {
    return [...title, `TVL <b>${compact(vault.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b>`, "<i>⚠️ Live holdings unavailable right now. Tap 🔄 Refresh.</i>"].join("\n");
  }
  const deposit = holdings.depositToken;
  const delta = holdings.navDeltaBps;
  const value = [
    `💰 <b>${compact(holdings.totalValue, deposit.decimals, deposit.symbol)}</b>`,
    holdings.totalUsd === null ? "" : ` ≈ ${compactUsd(holdings.totalUsd)}`,
    delta === null ? "" : ` · vs NAV ${signIcon(delta)} ${signedPercent(delta)}`,
  ].join("");
  const lines = [...title, value];
  if (holdings.partial) {
    const unpriced = holdings.unpriced.map(escapeHtml).join(", ") || "some tokens";
    lines.push(`<blockquote>⚠️ Partial view: no price for ${unpriced}. Missing value is not zero.</blockquote>`);
  }
  lines.push("", "<b>Tokens</b>", ...(holdings.tokens.length > 0 ? tokenRows(holdings.tokens) : ["<i>None.</i>"]));
  if (!strategies) lines.push("<i>⚠️ Positions unavailable right now. Tap 🔄 Refresh.</i>");
  else {
    const positions = positionRows(strategies);
    if (positions.length > 0) lines.push("", "<b>Positions</b>", ...positions);
  }
  return lines.join("\n");
}

function dlmmBlock(s: DlmmStrategy): string[] {
  const { tokenX, tokenY } = s;
  return [
    `🌊 <b>${pair(tokenX, tokenY)}</b> · Meteora DLMM · ${rangeStatus(s)}`,
    `<code>${price(s.lowerPrice)} ${rangeGauge(Number(s.lowerPrice), Number(s.activePrice), Number(s.upperPrice))} ${price(s.upperPrice)}</code>`,
    ...tree([
      `Now <b>${price(s.activePrice)}</b>`,
      `Holds ${compact(s.amountX, tokenX.decimals, tokenX.symbol)} + ${compact(s.amountY, tokenY.decimals, tokenY.symbol)}`,
      `Fees ${compact(s.pendingFeeX, tokenX.decimals, tokenX.symbol)} + ${compact(s.pendingFeeY, tokenY.decimals, tokenY.symbol)}`,
    ]),
    address(s.position),
  ];
}

export function strategiesMessage(vault: VaultSummary, strategies: Strategy[]): string {
  const title = `🧩 <b>${escapeHtml(vault.name)}</b> · strategies`;
  if (strategies.length === 0) return `${title}\n\nNo open strategies.`;
  const blocks: string[][] = [];
  const tokens = strategies.flatMap((s) => (s.type === "jupiter" ? [s] : []));
  if (tokens.length > 0) {
    blocks.push([
      "💱 <b>Tokens</b>",
      ...tree(tokens.map((t) => `${escapeHtml(t.symbol)} ${compactUnits(t.vaultBalance, t.decimals)}${t.vaultBalance === "0" ? " · <i>empty</i>" : ""}`)),
    ]);
  }
  for (const s of strategies) {
    if (s.type === "dlmm") blocks.push(dlmmBlock(s));
    // Phoenix equity is in USDC atoms (6 decimals).
    if (s.type === "phoenix") blocks.push(["📈 <b>Phoenix perps</b>", ...tree([`Equity ${compact(s.equity, 6, "USDC")} · leverage ${leverage(s.leverage)}`])]);
    if (s.type === "unreadable") blocks.push([`⚠️ <b>Unreadable ${escapeHtml(s.protocol)} strategy</b>`, address(s.address), `<i>${escapeHtml(s.reason)}</i>`]);
  }
  return [`${title} (${strategies.length})`, ...blocks.map((block) => block.join("\n"))].join("\n\n");
}

/** One LP position as a card: where the price is, what it is worth, PnL, fees, and range. */
export function positionMessage(vault: VaultSummary, s: DlmmStrategy, nowSeconds: number): string {
  const { tokenX, tokenY } = s;
  const withUsd = (baseUnits: string, token: typeof tokenX) => {
    const value = tokenUsd(baseUnits, token);
    return `${compact(baseUnits, token.decimals, token.symbol)}${value === null ? "" : ` (${compactUsd(value)})`}`;
  };
  const value = lpValueUsd(s);
  const fees = lpFeesUsd(s);
  const pnl = lpPnl(s);
  const lines = [
    `🌊 <b>${pair(tokenX, tokenY)}</b> · Meteora DLMM`,
    `${escapeHtml(vault.name)} · <a href="https://solscan.io/account/${encodeURIComponent(s.position)}">Position ${escapeHtml(shortAddress(s.position))} ↗</a>`,
    DIVIDER,
    rangePlace(s),
    gaugeLine(s),
    "",
    `💰 <b>Value ${value === null ? "n/a" : compactUsd(value)}</b>`,
    ...tree([withUsd(s.amountX, tokenX), withUsd(s.amountY, tokenY)]),
  ];
  if (pnl) lines.push("", `📈 <b>PnL ${pnl}</b>`, "└ <i>All-time, from Meteora</i>");
  lines.push(
    "",
    `🎁 <b>Unclaimed fees${fees === null ? "" : ` ${compactUsd(fees)}`}</b>`,
    ...tree([compact(s.pendingFeeX, tokenX.decimals, tokenX.symbol), compact(s.pendingFeeY, tokenY.decimals, tokenY.symbol)]),
    "",
    `🎯 <b>Range</b> · ${escapeHtml(tokenY.symbol)} per ${escapeHtml(tokenX.symbol)}`,
    ...tree([`Min ${price(s.lowerPrice)}`, `Now <b>${price(s.activePrice)}</b>`, `Max ${price(s.upperPrice)}`]),
  );
  if (s.createdTs !== undefined) lines.push("", `📅 Opened ${utc(s.createdTs)} · open ${duration(Math.max(0, nowSeconds - s.createdTs))}`);
  lines.push(address(s.position));
  return lines.join("\n");
}

export function navHistoryMessage(vault: VaultSummary, points: NavHistoryPoint[]): string {
  const title = `📊 <b>${escapeHtml(vault.name)}</b> · NAV history`;
  if (points.length === 0) return `${title}\n\nNo NAV posted yet.`;
  // `points` arrive oldest first; each epoch is compared with the one before it.
  const blocks = points.map((point, index) => {
    const previous = points[index - 1];
    const change = previous && changePercent(previous.navPerShare, point.navPerShare);
    const rows = [
      `Assets <b>${amount(point.totalAssets, vault.depositDecimals, vault.depositSymbol)}</b>`,
      `Per share ${formatBaseUnits(point.navPerShare, 9)}${change ? ` · ${signIcon(change.sign)} ${change.text}` : ""}`,
    ];
    if (point.overridden) rows.push("⚠️ Admin override");
    return [`<b>Epoch ${point.epoch}</b>${point.ts === null ? "" : ` · ${utc(point.ts)}`}`, ...tree(rows)].join("\n");
  });
  const first = points[0];
  const last = points[points.length - 1];
  const lines = [title, `<i>Latest ${points.length} epochs, newest first</i>`];
  if (first && last && points.length > 1) {
    const total = changePercent(first.navPerShare, last.navPerShare);
    lines.push(
      "",
      "<b>NAV per share</b>, oldest → newest",
      `<code>${sparkline(points.map((point) => BigInt(point.navPerShare)))}</code>`,
      ...tree([`Now <b>${formatBaseUnits(last.navPerShare, 9)}</b>`, `Over ${points.length} epochs ${total ? `${signIcon(total.sign)} ${total.text}` : "n/a"}`]),
    );
  }
  return [...lines, "", blocks.reverse().join("\n\n")].join("\n");
}

const requestState = (state: "pending" | "resolvable") => (state === "resolvable" ? "ready to settle" : "waiting for the next NAV");

export function requestsMessage(vault: VaultSummary, queue: RequestQueue): string {
  const lines = [`📋 <b>${escapeHtml(vault.name)}</b> · queued requests`, "", `<b>Deposits</b> (${queue.deposits.length})`];
  if (queue.deposits.length === 0) lines.push("<i>None.</i>");
  for (const deposit of queue.deposits) {
    lines.push(`• ${amount(deposit.amount, vault.depositDecimals, vault.depositSymbol)} from ${escapeHtml(shortAddress(deposit.owner))} · ${requestState(deposit.state)}`);
  }
  lines.push("", `<b>Withdrawals</b> (${queue.withdrawals.length})`);
  if (queue.withdrawals.length === 0) lines.push("<i>None.</i>");
  for (const withdrawal of queue.withdrawals) {
    lines.push(`• ${shares(withdrawal.shares, vault.depositDecimals)} from ${escapeHtml(shortAddress(withdrawal.owner))} · ${requestState(withdrawal.state)}`);
  }
  lines.push("", "<i>Requests settle after a later NAV is posted. Anyone can settle a ready request.</i>");
  return lines.join("\n");
}

const STRATEGY_TYPE_LABEL = { jupiter: "Swap", dlmm: "Meteora DLMM", phoenix: "Phoenix perps" } as const;
export const STRATEGY_HISTORY_LIMIT = 10;

type ClosedToken = StrategyHistoryItem["tokens"][number];

/** "🔴 USDC -0.5" with the sign spelled out, or raw base units when decimals are unknown. */
function realizedPnl(token: Pick<ClosedToken, "mint" | "symbol" | "decimals" | "realizedPnl">): string {
  const symbol = escapeHtml(token.symbol ?? shortAddress(token.mint));
  const sign = BigInt(token.realizedPnl);
  if (token.decimals === null) return `${signIcon(sign)} ${escapeHtml(token.realizedPnl)} base units of ${address(token.mint)}`;
  const value = signedAmount(token.realizedPnl, token.decimals, "").trimEnd();
  return `${signIcon(sign)} ${symbol} <b>${sign > 0n ? "+" : ""}${value}</b>`;
}

export function strategyHistoryMessage(vault: VaultSummary, items: StrategyHistoryItem[]): string {
  const title = `🗂 <b>${escapeHtml(vault.name)}</b> · closed strategies`;
  if (items.length === 0) return `${title}\n\nNo closed strategies yet.`;
  const shown = items.slice(0, STRATEGY_HISTORY_LIMIT);
  const totals = new Map<string, ClosedToken>();
  for (const token of shown.flatMap((item) => item.tokens)) {
    const sum = totals.get(token.mint);
    const realized = (BigInt(sum?.realizedPnl ?? "0") + BigInt(token.realizedPnl)).toString();
    totals.set(token.mint, { ...token, realizedPnl: realized });
  }
  const blocks = shown.map((item) => {
    const pair = item.type === "dlmm" && item.tokens.length > 0 ? ` · ${item.tokens.map((t) => escapeHtml(t.symbol ?? shortAddress(t.mint))).join("/")}` : "";
    const held = item.openedTs === null ? "" : `⏱ Held ${duration(item.closedTs - item.openedTs)} · `;
    const rows = item.tokens.map((token) => {
      const fees = token.decimals !== null && token.feesRetained !== "0" ? ` · fees +${amount(token.feesRetained, token.decimals, "").trimEnd()}` : "";
      return `${realizedPnl(token)}${fees}`;
    });
    const lines = [
      `<b>${item.type ? STRATEGY_TYPE_LABEL[item.type] : "Strategy"}</b>${pair}`,
      `🕓 Closed ${utc(item.closedTs)}`,
      `${held}🔗 ${txLink(item.closeSignature)}`,
      ...tree(rows.length > 0 ? rows : ["<i>No token flows recorded.</i>"]),
    ];
    if (!item.exact) lines.push("<i>Opened before exact accounting; totals may be incomplete.</i>");
    return lines.join("\n");
  });
  return [
    title,
    `<i>Latest ${blocks.length}, newest first</i>`,
    "",
    ...(totals.size === 0 ? [] : [`<b>Realized PnL</b>, all ${blocks.length} combined`, ...tree([...totals.values()].map(realizedPnl)), ""]),
    blocks.join("\n\n"),
  ].join("\n");
}

const pauseLabel = (paused: boolean) => (paused ? "⏸ paused" : "▶️ open");

export function settingsMessage(vault: VaultDetail): string {
  const token = { mint: vault.depositMint, symbol: vault.depositSymbol, decimals: vault.depositDecimals };
  const lines = [
    `⚙️ <b>${escapeHtml(vault.name)}</b> · settings`,
    "",
    "<b>Status</b>",
    ...tree([
      `Vault ${status(vault.status)}`,
      ...(vault.protocol.status === "normal" ? [] : [`Protocol ${status(vault.protocol.status)}`]),
      `Deposits ${pauseLabel(vault.depositPaused)}`,
      `Withdrawals ${pauseLabel(vault.withdrawalPaused)}`,
    ]),
    "",
    "<b>Fees</b>",
    ...tree([`Performance ${feePercent(vault.performanceFeeBps)}`, `Management ${feePercent(vault.managementFeeBps)} a year`]),
  ];
  if (vault.pendingPerformanceFeeBps !== vault.performanceFeeBps || vault.pendingManagementFeeBps !== vault.managementFeeBps) {
    lines.push(`<i>Changing to ${feePercent(vault.pendingPerformanceFeeBps)} and ${feePercent(vault.pendingManagementFeeBps)} on ${utc(vault.feeEffectiveTs)}.</i>`);
  }
  lines.push(
    "",
    "<b>Limits</b>",
    ...tree([
      `Deposit cap ${cap(vault.depositCap, token)}`,
      `Min deposit ${amount(vault.minDeposit, token.decimals, token.symbol)}`,
      `Min withdrawal ${shares(vault.minWithdrawalShares, token.decimals)}`,
    ]),
    "",
    "<b>Pending</b>",
    ...tree([
      `Deposits ${amount(vault.pendingDeposits, token.decimals, token.symbol)}`,
      `Withdrawals ${shares(vault.pendingWithdrawalShares, token.decimals)}`,
      `Unclaimed manager fee ${shares(vault.unclaimedManagerFeeShares, token.decimals)}`,
      `Open strategies ${vault.openStrategyCount}`,
    ]),
  );
  return lines.join("\n");
}

export function phoenixMessage(vault: VaultSummary, phoenix: PhoenixManager): string {
  const lines = [`📈 <b>${escapeHtml(vault.name)}</b> · Phoenix perps`, ""];
  if (!phoenix.usdcVault) {
    lines.push(`Phoenix needs a vault whose deposit token is USDC. This vault uses ${escapeHtml(vault.depositSymbol)}.`);
    return lines.join("\n");
  }
  if (phoenix.status === "none") {
    lines.push("No Phoenix strategy yet.", "<i>Step 1 of 2: set up the strategy. Step 2 registers the vault's trader with Phoenix.</i>");
    return lines.join("\n");
  }
  lines.push("Trader", address(phoenix.traderAccount));
  if (phoenix.status === "registered") {
    lines.push("", "<i>Step 2 of 2: onboard the trader with Phoenix. Then you can deposit USDC and trade.</i>");
    return lines.join("\n");
  }
  const { account } = phoenix;
  if (account) {
    const equity = BigInt(account.equity);
    // Bar math only; displayed amounts stay base-unit strings.
    const usedBps = equity > 0n ? Number((BigInt(account.initialMargin) * 10_000n) / equity) : null;
    lines.push(
      "",
      "<b>Account</b>",
      ...tree([
        `Equity <b>${usdcAmount(account.equity)}</b>`,
        `Collateral ${usdcAmount(account.collateral)}`,
        `Withdrawable ${usdcAmount(account.withdrawable)}`,
        `Risk ${account.riskState === "healthy" ? "🟢" : "⚠️"} ${escapeHtml(account.riskState)}`,
      ]),
      "",
      `<b>Margin</b> ${[bar(usedBps), usedBps === null ? "" : `${percent(usedBps)} of equity`].filter(Boolean).join(" ")}`,
      ...tree([`Used ${usdcAmount(account.initialMargin)}`, `Maintenance ${usdcAmount(account.maintenanceMargin)}`]),
    );
    const positions = Object.entries(account.liquidationPrices);
    lines.push("", `<b>Positions</b> (${positions.length})`);
    if (positions.length === 0) lines.push("<i>None.</i>");
    for (const [symbol, price] of positions) lines.push(`• ${escapeHtml(symbol)} · liquidation at $${escapeHtml(price)}`);
  } else {
    lines.push("<i>Phoenix did not report margin right now.</i>");
  }
  if (phoenix.openOrders === null) {
    lines.push("", "<i>Phoenix did not report open orders right now.</i>");
  } else {
    lines.push("", `<b>Open orders</b> (${phoenix.openOrders.length})`);
    if (phoenix.openOrders.length === 0) lines.push("<i>None.</i>");
    for (const order of phoenix.openOrders) {
      lines.push(
        `${order.side === "long" ? "🟢" : "🔴"} <b>${escapeHtml(order.symbol)} ${order.side}</b> ${escapeHtml(order.size)} at $${escapeHtml(order.price)}${order.reduceOnly ? " · reduce-only" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function liquidityAmounts(liquidity: Liquidity): string {
  const parts = [
    liquidity.amountX !== "0" ? amount(liquidity.amountX, liquidity.tokenX.decimals, liquidity.tokenX.symbol) : "",
    liquidity.amountY !== "0" ? amount(liquidity.amountY, liquidity.tokenY.decimals, liquidity.tokenY.symbol) : "",
  ];
  return parts.filter(Boolean).join(" + ");
}

export function actionTitle(action: PendingAction): string {
  switch (action.kind) {
    case "swap":
      return `Swap ${amount(action.amountBaseUnits, action.input.decimals, action.input.symbol)} → ${escapeHtml(action.output.symbol)}`;
    case "dlmmClaim":
      return `Claim fees from the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmRemove":
      return `Remove ${action.bps / 100}% of the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmZapOut":
      return `Zap out the ${escapeHtml(action.pairLabel)} position to ${escapeHtml(action.depositSymbol)}`;
    case "closeStrategy":
      return `Close the empty ${escapeHtml(action.label)}`;
    case "dlmmAdd":
      return `Add ${liquidityAmounts(action.liquidity)} to the ${escapeHtml(action.pairLabel)} position`;
    case "dlmmOpen":
      return `Open a ${escapeHtml(action.pairLabel)} position with ${liquidityAmounts(action.liquidity)}`;
    case "dlmmInit":
      return `Create an empty ${escapeHtml(action.pairLabel)} position`;
    case "dlmmClose":
      return `Close the ${escapeHtml(action.pairLabel)} position`;
    case "jupiterInit":
      return `Track ${escapeHtml(action.token.symbol)} (open its swap strategy)`;
    case "phoenixInit":
      return "Set up the Phoenix strategy";
    case "phoenixOnboard":
      return "Onboard the vault's Phoenix trader";
    case "phoenixDeposit":
      return `Deposit ${usdcAmount(action.amountBaseUnits)} into Phoenix`;
    case "phoenixWithdraw":
      return `Withdraw ${usdcAmount(action.amountBaseUnits)} from Phoenix`;
    case "phoenixOrder": {
      const { order } = action;
      const how = order.order.type === "market" ? "at market" : `limit at $${escapeHtml(order.order.price)}`;
      return `${order.side === "long" ? "Long" : "Short"} ${escapeHtml(order.size)} ${escapeHtml(order.symbol)} ${how}`;
    }
    case "phoenixCancel":
      return `Cancel all open ${escapeHtml(action.symbol)} orders`;
    case "phoenixSweep":
      return "Sweep Phoenix withdrawals into USDC";
    case "vaultCreate":
      return `Create the vault "${escapeHtml(action.name)}"`;
    case "vaultUpdate":
      return "Update vault settings";
    case "vaultClaimFee":
      return "Claim the manager fee";
    case "vaultClose":
      return "Close this vault";
  }
}

const STATUS_WORDS: Record<VaultStatus, string> = { normal: "Normal", reduceOnly: "Reduce-only", paused: "Paused" };

function changeLines(changes: VaultChanges, deposit: TokenRef): string[] {
  const lines: string[] = [];
  if (changes.status !== undefined) lines.push(`Status → <b>${STATUS_WORDS[changes.status]}</b>`);
  if (changes.depositPaused !== undefined) lines.push(`Deposits → <b>${changes.depositPaused ? "paused" : "open"}</b>`);
  if (changes.withdrawalPaused !== undefined) lines.push(`Withdrawals → <b>${changes.withdrawalPaused ? "paused" : "open"}</b>`);
  if (changes.performanceFeeBps !== undefined) lines.push(`Performance fee → <b>${feePercent(changes.performanceFeeBps)}</b>`);
  if (changes.managementFeeBps !== undefined) lines.push(`Management fee → <b>${feePercent(changes.managementFeeBps)}</b> a year`);
  if (changes.depositCap !== undefined) lines.push(`Deposit cap → <b>${cap(changes.depositCap, deposit)}</b>`);
  if (changes.minDeposit !== undefined) lines.push(`Min deposit → <b>${amount(changes.minDeposit, deposit.decimals, deposit.symbol)}</b>`);
  if (changes.minWithdrawalShares !== undefined) lines.push(`Min withdrawal → <b>${shares(changes.minWithdrawalShares, deposit.decimals)}</b>`);
  return lines;
}

function paramLines(params: VaultParams, deposit: TokenRef): string[] {
  return [
    `Performance fee ${feePercent(params.performanceFeeBps)} · management fee ${feePercent(params.managementFeeBps)} a year`,
    `Deposit cap ${cap(params.depositCap, deposit)}`,
    `Min deposit ${amount(params.minDeposit, deposit.decimals, deposit.symbol)} · min withdrawal ${shares(params.minWithdrawalShares, deposit.decimals)}`,
  ];
}

const UNVERIFIED_WARNING = "⚠️ Jupiter has not verified this token. Check the contract address before you confirm.";
const RENT_NOTE = "Creating the position costs a small refundable SOL rent from the manager wallet.";

/** A confirm screen's content: a headline, detail rows, then plain notes and warnings. */
interface Receipt {
  headline: string;
  rows: string[];
  notes: string[];
  warnings: string[];
}

function receipt(action: PendingAction, quote: Quote | undefined): Receipt {
  const r: Receipt = { headline: actionTitle(action), rows: [], notes: [], warnings: [] };
  switch (action.kind) {
    case "swap":
      if (quote) r.rows.push(`You get <b>≈ ${amount(quote.outAmount, action.output.decimals, action.output.symbol)}</b>`);
      r.rows.push(`Slippage ${action.slippageBps / 100}%${quote ? ` · impact ${escapeHtml(quote.priceImpactPct)}%` : ""}`);
      if (action.unverified) r.warnings.push(UNVERIFIED_WARNING);
      break;
    case "dlmmOpen": {
      const bins = action.upperBinId - action.lowerBinId;
      r.headline = `Open ${escapeHtml(action.pairLabel)} LP`;
      r.rows.push(
        `Deposit ${liquidityAmounts(action.liquidity)}`,
        `Range ${escapeHtml(action.priceRange.low)} → ${escapeHtml(action.priceRange.high)}`,
        `Bins ${bins} · ${shapeLabel(action.liquidity.shape)}`,
        `Transactions ~${Math.ceil(bins / DLMM_BINS_PER_TRANSACTION)}`,
      );
      r.notes.push(RENT_NOTE);
      break;
    }
    case "dlmmInit":
      r.rows.push(`Range ${escapeHtml(action.priceRange.low)} → ${escapeHtml(action.priceRange.high)}`, `Bins ${action.upperBinId - action.lowerBinId}`);
      r.notes.push(`Adds no liquidity. ${RENT_NOTE}`);
      break;
    case "dlmmAdd":
      r.headline = `Add to ${escapeHtml(action.pairLabel)} LP`;
      r.rows.push(`Deposit ${liquidityAmounts(action.liquidity)}`, `Shape ${shapeLabel(action.liquidity.shape)}`);
      r.notes.push(`${shapeLabel(action.liquidity.shape)} shape across the position's existing range.`);
      break;
    case "dlmmRemove":
      if (action.bps === 10_000) r.notes.push("Tokens return to the vault; the empty position stays open.");
      break;
    case "dlmmZapOut":
      r.notes.push("Removes all liquidity, claims fees, swaps to the deposit token, and closes the position. Large positions take several transactions.");
      break;
    case "dlmmClose":
      r.warnings.push("⚠️ This removes all of the position's liquidity, claims its fees back to the vault, and closes it. Large positions take several transactions.");
      break;
    case "jupiterInit":
      r.rows.push(`Mint ${address(action.token.mint)}`);
      r.notes.push("Lets the vault hold and swap this token.");
      if (action.verified !== true) r.warnings.push(UNVERIFIED_WARNING);
      break;
    case "phoenixWithdraw":
      r.notes.push("If Phoenix queues the withdrawal, tap 🧹 Sweep once it arrives to turn it into USDC.");
      break;
    case "phoenixOrder": {
      const { order } = action;
      if (order.order.type === "market") r.rows.push(`Slippage limit ${order.order.slippageBps / 100}% around the mark price`);
      else if (order.order.postOnly) r.rows.push("Post-only: cancelled instead of filling right away");
      if (order.reduceOnly) r.rows.push("Reduce-only: can only shrink an open position");
      break;
    }
    case "vaultCreate":
      r.rows.push(`Deposit token <b>${escapeHtml(action.deposit.symbol)}</b> ${address(action.deposit.mint)}`, ...paramLines(action, action.deposit));
      r.notes.push("Your active wallet becomes the vault's manager. The deposit token cannot change later.");
      break;
    case "vaultUpdate":
      r.rows.push(...changeLines(action.changes, action.deposit));
      if (action.changes.status === "paused") {
        r.warnings.push("⚠️ Paused stops depositors from withdrawing, and blocks deposits and trading, until you set the vault back to Normal.");
      }
      if (action.changes.status === "reduceOnly") r.notes.push("Reduce-only blocks new deposits and new trades. Withdrawals still work.");
      if (action.changes.performanceFeeBps !== undefined || action.changes.managementFeeBps !== undefined) {
        r.notes.push("New fees may take effect only after a waiting period. ⚙️ Settings shows when.");
      }
      break;
    case "vaultClaimFee":
      r.notes.push("Mints the manager's accrued fee shares to your wallet.");
      break;
    case "vaultClose":
      r.warnings.push(
        "⚠️ Closing deletes this vault for good. Nobody can deposit into it again. It only works once no shares, pending requests, unclaimed fees, open strategies, or assets remain.",
      );
      break;
    default:
      break;
  }
  return r;
}

/** `vault` is unset only when creating one. */
export function confirmMessage(vault: VaultSummary | undefined, action: PendingAction, quote?: Quote): string {
  const { headline, rows, notes, warnings } = receipt(action, quote);
  return [
    `🧾 <b>Review</b>${vault ? ` · ${escapeHtml(vault.name)}` : ""}`,
    DIVIDER,
    `<b>${headline}</b>`,
    ...tree(rows),
    DIVIDER,
    ...warnings.map((warning) => `<blockquote>${warning}</blockquote>`),
    ...notes.map((note) => `<i>${note}</i>`),
    `<blockquote>⚡ Real mainnet transaction from ${vault ? "the vault" : "your manager wallet"}. Cannot be undone.</blockquote>`,
  ].join("\n");
}

type TxState = "pending" | "unknown" | "confirmed";
const TX_STATE_LABEL: Record<TxState, string> = { confirmed: "✅ Confirmed", pending: "📤 Sent", unknown: "❓ Checking" };

/** Each transaction once, at its latest state, as a numbered Solscan link. */
function progressLines(progress: Progress[]): string[] {
  const actions = new Set<string>();
  const states = new Map<string, TxState>();
  for (const step of progress) {
    if (step.kind === "building") actions.add(step.action);
    else states.set(step.signature, step.kind === "confirmed" ? "confirmed" : step.status);
  }
  const links: Record<TxState, string[]> = { confirmed: [], pending: [], unknown: [] };
  [...states].forEach(([signature, state], index) =>
    links[state].push(`<a href="https://solscan.io/tx/${encodeURIComponent(signature)}">#${index + 1}</a>`),
  );
  return [
    ...[...actions].map((action) => `🛠 <code>${escapeHtml(action)}</code>`),
    ...(["confirmed", "pending", "unknown"] as const).filter((state) => links[state].length > 0).map((state) => `${TX_STATE_LABEL[state]} ${links[state].join(" ")}`),
  ];
}

/** Live view while an action runs; `outcome` appears once it ends. */
export function executionMessage(action: PendingAction, progress: Progress[], outcome?: Outcome, scope?: string): string {
  const lines = [`${outcome ? outcomeIcon(outcome) : "⏳"} <b>${actionTitle(action)}</b>`, ""];
  if (outcome?.kind === "confirmed") return [...lines, ...confirmedLines(outcome)].join("\n");
  lines.push(...progressLines(progress), "");
  if (!outcome) return [...lines, "<i>Working… keep this chat open.</i>"].join("\n");
  switch (outcome.kind) {
    case "refused":
      lines.push("<b>Not signed.</b> The bot refused a transaction from the API:", `<i>${escapeHtml(outcome.reason)}</i>`);
      break;
    case "failed":
      lines.push(`<b>Failed</b> (${escapeHtml(outcome.code)}): ${escapeHtml(outcome.message)}`);
      {
        const hint = errorHint(outcome.code, outcome.message, scope);
        if (hint) lines.push(`<i>${escapeHtml(hint)}</i>`);
      }
      if (outcome.signature) lines.push(`Transaction ${txLink(outcome.signature)}`);
      if (outcome.signatures.length > 0) lines.push("<i>Earlier transactions in this action already landed. Check the position before retrying.</i>");
      break;
    case "unresolved":
      lines.push(
        "<b>Outcome unknown.</b> These may still land:",
        ...outcome.pending.map((signature) => `• ${txLink(signature)}`),
        "<i>Check Solscan before trying again. Do not resend blindly.</i>",
      );
      break;
  }
  return lines.join("\n");
}

/** Success hides the per-transaction steps; failures keep them so the operator can check what landed. */
const confirmedLines = (outcome: Extract<Outcome, { kind: "confirmed" }>) => [
  `<b>Done.</b> ${outcome.signatures.length} confirmed.`,
  ...(outcome.created?.vault ? [`New vault ${address(outcome.created.vault)}`] : []),
  ...(outcome.created?.position ? [`New position ${address(outcome.created.position)}`] : []),
];

const outcomeIcon = (outcome: Outcome) => ({ confirmed: "✅", refused: "🛑", failed: "❌", unresolved: "❓" })[outcome.kind];

const tokenLabel = (token: TokenRef & { pasted?: boolean; verified?: boolean | null }) =>
  `<b>${escapeHtml(token.symbol)}</b>${"pasted" in token && token.pasted ? ` ${address(token.mint)}` : ""}`;

export function swapFormMessage(form: SwapForm, inputBalanceBaseUnits: string | undefined): string {
  const lines = [`💱 <b>Swap</b> · ${form.side === "buy" ? "buy with" : "sell for"} ${escapeHtml(form.deposit.symbol)}`, ""];
  lines.push(`Token ${form.token ? tokenLabel(form.token) : "<i>not set: pick one or paste a contract address</i>"}`);
  if (form.token && needsWarning(form.token)) lines.push(`⚠️ <i>${form.token.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  const input = form.token ? (form.side === "buy" ? form.deposit : form.token) : undefined;
  lines.push(`Amount ${escapeHtml(describeAmount(form.amount, input, (base, decimals) => amount(base, decimals, "").trim()))}`);
  if (input && inputBalanceBaseUnits !== undefined) lines.push(`Vault ${escapeHtml(input.symbol)} ${amount(inputBalanceBaseUnits, input.decimals, input.symbol)}`);
  lines.push(`Slippage ${form.slippageBps / 100}%`);
  return lines.join("\n");
}

export function swapQuoteMessage(form: SwapForm, tokens: { input: TokenRef; output: TokenRef }, amountBaseUnits: string, quote: Quote): string {
  const lines = [
    `💱 <b>${escapeHtml(tokens.input.symbol)} → ${escapeHtml(tokens.output.symbol)}</b>`,
    "",
    `You give <b>${amount(amountBaseUnits, tokens.input.decimals, tokens.input.symbol)}</b>`,
    `You get  <b>≈ ${amount(quote.outAmount, tokens.output.decimals, tokens.output.symbol)}</b>`,
    "",
    `Price impact ${escapeHtml(quote.priceImpactPct)}% · slippage ${quote.slippageBps / 100}%`,
    `Route ${quote.routeLabels.map(escapeHtml).join(" → ") || "unknown"}`,
  ];
  if (form.token && needsWarning(form.token)) lines.push("", "⚠️ <i>This token is not Jupiter-verified. Check the contract address.</i>");
  lines.push("", "<i>A quote is not a promise. The trade can still fail or price differently.</i>");
  return lines.join("\n");
}

function poolPickerMessage(form: LpForm): string {
  const lines = ["➕ <b>New LP position</b> · pick a pool"];
  const choices = form.poolChoices ?? [];
  if (choices.length === 0 || form.poolQuery === undefined) {
    lines.push("", `Pool <i>not set: paste a pool address or search, e.g. "SOL"</i>`, `<i>The pool must include ${escapeHtml(form.deposit.symbol)}.</i>`);
    return lines.join("\n");
  }
  lines.push(`<i>Results for "${escapeHtml(form.poolQuery)}" · paired with ${escapeHtml(form.deposit.symbol)}</i>`);
  choices.forEach((choice, index) => {
    const fee = choice.baseFeePct === null ? "" : ` · fee ${feePct(choice.baseFeePct)}`;
    lines.push(
      "",
      `<b>${index + 1}. ${escapeHtml(choice.pair)}</b>${fee} · bin ${choice.binStep}`,
      `└ TVL ${compactUsd(choice.tvl)} · Vol 24h ${compactUsd(choice.volume24h)}`,
    );
  });
  return lines.join("\n");
}

/** How an amount input reads next to the vault's balance: "5 (50% of balance)". */
function depositAmount(input: AmountInput | undefined, token: TokenRef, balanceBaseUnits: string | undefined): string {
  if (!input) return "<i>not set</i>";
  if (input.kind === "exact") return compactUnits(input.baseUnits, token.decimals);
  const share = input.bps === 10_000 ? "max" : `${input.bps / 100}% of balance`;
  return balanceBaseUnits === undefined ? share : `${compactUnits(((BigInt(balanceBaseUnits) * BigInt(input.bps)) / 10_000n).toString(), token.decimals)} (${share})`;
}

/** The LP amount picker: one token's balance and its current amount. */
export function lpAmountMessage(form: LpForm, token: TokenRef, balanceBaseUnits: string): string {
  const current = form.picking ? form[form.picking] : undefined;
  return [
    `💧 <b>How much ${escapeHtml(token.symbol)}?</b>`,
    DIVIDER,
    `Idle in vault <b>${amount(balanceBaseUnits, token.decimals, token.symbol)}</b>`,
    `Now ${current ? escapeHtml(describeAmount(current, token, (base, decimals) => amount(base, decimals, "").trim())) : "<i>not set</i>"}`,
    "",
    "<i>Tap a share of the balance, or ✏️ Custom amount to type one.</i>",
  ].join("\n");
}

export function lpFormMessage(form: LpForm, range: PriceRange | string | undefined, balances: { x: string; y: string } | undefined): string {
  const pool = form.pool;
  if (!pool) return poolPickerMessage(form);
  const { tokenX, tokenY } = pool;
  const x = escapeHtml(tokenX.symbol);
  const y = escapeHtml(tokenY.symbol);
  const fee = form.baseFeePct === null ? "" : ` · fee ${feePct(form.baseFeePct)}`;
  const lines = [
    form.mode === "add" ? `➕ <b>${x}/${y}</b> · add liquidity${fee} · bin ${pool.binStep}` : `🎯 <b>${x}/${y}</b>${fee} · bin ${pool.binStep}`,
    DIVIDER,
    `Price <b>${price(pool.activePrice)}</b> ${y} per ${x}`,
  ];
  if (balances) lines.push(`Idle in vault ${compact(balances.x, tokenX.decimals, tokenX.symbol)} · ${compact(balances.y, tokenY.decimals, tokenY.symbol)}`);
  lines.push("");
  let holdsX = true;
  let holdsY = true;
  if (form.mode === "add") lines.push(`Shape <b>${shapeLabel(form.shape)}</b> · across the position's range`);
  else {
    const side =
      form.side === "both" ? "⚖️ <b>Both sides</b>" : form.side === "x" ? `💵 <b>${x} only</b> · sell as price rises` : `🎯 <b>${y} only</b> · buy ${x} as price falls`;
    const preset = form.rangeBps === undefined ? "custom" : rangePresetLabel(form.side, form.rangeBps);
    lines.push(`${side} · ${shapeLabel(form.shape)} · ${preset}`);
    if (typeof range === "string") lines.push(`⚠️ <i>${escapeHtml(range)}</i>`);
    else if (range) {
      holdsX = range.sides !== "y";
      holdsY = range.sides !== "x";
      const holds = range.sides === "both" ? "both tokens" : `only ${range.sides === "x" ? x : y}`;
      lines.push(
        `<code>${escapeHtml(formatPrice(range.lowPrice))} ${rangeGauge(range.lowPrice, Number(pool.activePrice), range.highPrice)} ${escapeHtml(formatPrice(range.highPrice))}</code>`,
        `<i>${range.binCount} bins · holds ${holds}</i>`,
      );
    }
  }
  const deposits = [
    ...(holdsX ? [`${x} ${depositAmount(form.amountX, tokenX, balances?.x)}`] : []),
    ...(holdsY ? [`${y} ${depositAmount(form.amountY, tokenY, balances?.y)}`] : []),
  ];
  lines.push("", "<b>Deposit</b>", ...tree(deposits));
  return lines.join("\n");
}

export function phoenixTransferFormMessage(form: PhoenixTransferForm): string {
  const lines = [
    form.direction === "deposit" ? "💵 <b>Deposit USDC into Phoenix</b>" : "📤 <b>Withdraw from Phoenix</b>",
    "",
    `Amount ${escapeHtml(describeAmount(form.amount, form.usdc, (base, decimals) => amount(base, decimals, "").trim()))}`,
    form.direction === "deposit" ? "<i>Shares are of the vault's idle USDC.</i>" : "<i>Shares are of what Phoenix reports as withdrawable.</i>",
  ];
  return lines.join("\n");
}

export function orderFormMessage(form: OrderForm): string {
  const market = form.markets.find((m) => m.symbol === form.symbol);
  const lines = [
    "🆕 <b>Phoenix order</b>",
    "",
    `Market ${market ? `<b>${escapeHtml(market.symbol)}</b>${market.markPrice === "0" ? " · no mark price" : ` · mark $${escapeHtml(market.markPrice)}`}` : "<i>not set: tap a market</i>"}`,
    `Side ${form.side === "long" ? "🟢 long" : "🔴 short"}`,
    `Size ${form.size ? `${escapeHtml(form.size)}${market ? ` ${escapeHtml(market.symbol)}` : ""}` : "<i>not set</i>"}`,
    form.type === "market"
      ? `Market order · slippage ${form.slippageBps / 100}%`
      : `Limit order at ${form.price ? `$${escapeHtml(form.price)}` : "<i>price not set</i>"} · post-only ${form.postOnly ? "on" : "off"}`,
    `Reduce-only ${form.reduceOnly ? "on" : "off"}`,
  ];
  return lines.join("\n");
}

export function vaultFormMessage(form: VaultForm): string {
  const lines = [form.vault ? `✏️ <b>${escapeHtml(form.name ?? "Vault")}</b> · fees and limits` : "✨ <b>New vault</b>", ""];
  if (!form.vault) {
    lines.push(`Name ${form.name ? `<b>${escapeHtml(form.name)}</b>` : "<i>not set</i>"}`, `Deposit token ${tokenLabel(form.deposit)}`);
    if (needsWarning(form.deposit)) lines.push(`⚠️ <i>${form.deposit.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  }
  lines.push(...paramLines(form.params, form.deposit));
  if (form.vault && form.current) {
    const changed = changeLines(vaultChanges(form.params, form.current), form.deposit);
    lines.push("", changed.length ? "<b>Will change</b>" : "<i>Nothing changed yet.</i>", ...changed);
  }
  return lines.join("\n");
}

export function trackFormMessage(form: TrackForm): string {
  const lines = ["➕ <b>Track a token</b>", "", `Token ${form.token ? tokenLabel(form.token) : "<i>not set: paste a contract address</i>"}`];
  if (form.token && needsWarning(form.token)) lines.push(`⚠️ <i>${form.token.verified === false ? "Not verified by Jupiter." : "Verification unavailable."} Double-check the address.</i>`);
  else if (form.token) lines.push("✅ <i>Verified by Jupiter.</i>");
  lines.push("", "<i>Opens a swap strategy so the vault can hold this token.</i>");
  return lines.join("\n");
}

/** The API redacts 5xx messages; these codes are specific enough to say what to do next. */
const ERROR_HINTS: Record<string, string> = {
  JupiterUnsupportedCpiRoute: "Jupiter picked a route the vault program cannot run. Try a different amount or token, or try again shortly.",
  JupiterQuoteFailed: "Jupiter could not quote right now. Try again in a moment.",
  JupiterSwapFailed: "Jupiter could not build the swap right now. Try again in a moment.",
  RateLimited: "Too many requests. Wait a minute and try again.",
  InvalidTicket: "The build expired before it was sent. Start the action again.",
  Expired: "The transaction expired before it landed. It did not execute; you can try again.",
  PhoenixAlreadyOnboarded: "The vault's Phoenix trader is already onboarded. Open 📈 Phoenix again to deposit and trade.",
  PhoenixNoMark: "Phoenix has no mark price for this market right now. Try again shortly, or use a limit order.",
  HistoryUnavailable: "This server keeps no history database, so history is not available.",
  InvalidBasisPoints: "A fee must be between 0% and 100%.",
  InvalidMinimumAmount: "The minimum deposit and minimum withdrawal must both be more than zero.",
  VaultHasOutstandingShares: "Depositors still hold shares. The vault can close only after every share is withdrawn.",
  VaultHasPendingRequests: "Deposits or withdrawals are still queued. Wait for them to settle or be cancelled.",
  VaultHasUnclaimedFees: "Fees are still unclaimed. Claim the manager fee first; the platform fee must be claimed by the admin.",
  VaultHasOpenStrategies: "Strategies are still open. Close every strategy first.",
  VaultHasAssets: "The vault still holds assets. It can close only when empty.",
};

/** API 403 messages that a missing key setting causes, with the fix an admin makes. */
function forbiddenHint(message: string, scope: string | undefined): string | undefined {
  if (message === "Action is not enabled for this key") {
    return scope
      ? `This API key may not do "${scope}". Ask an admin to enable "${scope}"${scope === "read" ? "" : ' and "send"'} for this key in the dashboard.`
      : "This API key is missing a permission. Ask an admin to check its actions in the dashboard.";
  }
  if (message === "Vault creation requires a key without a vault restriction") {
    return 'Creating a vault needs an API key that is not limited to specific vaults. Ask an admin for one with "vault/initialize" and "send".';
  }
  if (message === "Vault is outside key scope") return "This API key is limited to other vaults. Ask an admin to add this vault to the key.";
  return undefined;
}

/** Plain words for an API error code. `scope` is the key action the request needed, e.g. "phoenix/order". */
export const errorHint = (code: string, message = "", scope?: string): string | undefined =>
  code === "Forbidden" ? forbiddenHint(message, scope) : ERROR_HINTS[code];

export function errorMessage(title: string, detail?: string): string {
  return detail ? `❌ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}` : `❌ ${escapeHtml(title)}`;
}
