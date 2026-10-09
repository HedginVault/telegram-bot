import type { HedgeClient, Strategy, VaultStatus, VaultSummary } from "@hedginvault/sdk";
import { type PendingAction, REMOVE_BPS, type RemoveBps, actionVault } from "./actions";
import {
  type Form,
  type FormDeps,
  createLpForm,
  createOrderForm,
  createPhoenixTransferForm,
  createSwapForm,
  createTrackForm,
  createVaultForm,
  renderForm,
  renderSwapQuote,
} from "./forms";
import {
  STRATEGY_HISTORY_LIMIT,
  confirmMessage,
  navHistoryMessage,
  phoenixMessage,
  positionMessage,
  requestsMessage,
  settingsMessage,
  strategiesMessage,
  strategyHistoryMessage,
  vaultMessage,
  vaultsMessage,
} from "./messages";
import {
  type Button,
  type IdStore,
  type PositionRef,
  type RenderedScreen,
  type Screen,
  ScreenNotice,
  button,
  expired,
  homeButton,
  keyboard,
  rowsOf,
  walletButton,
} from "./ui";

export interface ScreenDeps extends FormDeps {
  positions: IdStore<PositionRef>;
  forms: IdStore<Form>;
}

const confirmButton = (deps: ScreenDeps, text: string, action: PendingAction) =>
  button(text, { kind: "confirm", actionId: deps.actions.put(action) });

type DlmmStrategy = Extract<Strategy, { type: "dlmm" }>;
export const NAV_HISTORY_LIMIT = 10;
const STATUS_BUTTONS: { status: VaultStatus; text: string }[] = [
  { status: "normal", text: "🟢 Normal" },
  { status: "reduceOnly", text: "🟡 Reduce-only" },
  { status: "paused", text: "🔴 Paused" },
];
const pairLabel = (s: DlmmStrategy) => `${s.tokenX.symbol}/${s.tokenY.symbol}`;

async function findVault(api: HedgeClient, address: string): Promise<VaultSummary> {
  const vault = (await api.listVaults()).find((v) => v.address === address);
  if (!vault) throw new ScreenNotice("That vault is not managed by your active wallet's API key.");
  return vault;
}

async function findPosition(deps: ScreenDeps, refId: string): Promise<{ vault: VaultSummary; strategy: DlmmStrategy }> {
  const ref = deps.positions.get(refId);
  if (!ref) throw expired();
  const vault = await findVault(deps.api, ref.vault);
  const strategy = (await deps.api.getStrategies(vault.address)).find((s): s is DlmmStrategy => s.type === "dlmm" && s.position === ref.position);
  if (!strategy) throw new ScreenNotice("This position is closed or can no longer be read.");
  return { vault, strategy };
}

export async function renderScreen(screen: Screen, deps: ScreenDeps): Promise<RenderedScreen> {
  const { api } = deps;
  switch (screen.kind) {
    case "vaults": {
      const vaults = await api.listVaults();
      return {
        html: vaultsMessage(vaults),
        keyboard: keyboard([
          ...rowsOf(
            vaults.map((vault, index) => button(`${index + 1}. ${vault.name}`, { kind: "vault", vault: vault.address })),
            2,
          ),
          [button("✨ Create vault", { kind: "newVault" })],
          [button("🔄 Refresh", screen), walletButton()],
        ]),
      };
    }
    case "vault": {
      const vault = await findVault(api, screen.vault);
      const to = (text: string, kind: Extract<Screen, { vault: string }>["kind"]) => button(text, { kind, vault: vault.address });
      const [holdings, strategies] = await Promise.allSettled([api.getHoldings(vault.address), api.getStrategies(vault.address)]);
      return {
        html: vaultMessage(
          vault,
          holdings.status === "fulfilled" ? holdings.value : undefined,
          strategies.status === "fulfilled" ? strategies.value : undefined,
        ),
        keyboard: keyboard([
          [to("💱 Swap", "newSwap"), to("➕ New LP", "newLp")],
          [to("🧩 Strategies", "strategies"), to("📈 Phoenix", "phoenix")],
          [to("📊 NAV history", "navHistory"), to("📋 Requests", "requests")],
          [to("🗂 History", "strategyHistory"), to("⚙️ Settings", "settings")],
          [button("🔄 Refresh", screen), homeButton()],
        ]),
      };
    }
    case "navHistory":
    case "requests":
    case "strategyHistory": {
      const vault = await findVault(api, screen.vault);
      const html =
        screen.kind === "navHistory"
          ? navHistoryMessage(vault, (await api.getNavHistory(vault.address, NAV_HISTORY_LIMIT)).slice(-NAV_HISTORY_LIMIT))
          : screen.kind === "requests"
            ? requestsMessage(vault, await api.getRequests(vault.address))
            : strategyHistoryMessage(vault, (await api.getStrategyHistory(vault.address)).slice(0, STRATEGY_HISTORY_LIMIT));
      return { html, keyboard: keyboard([[button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton()]]) };
    }
    case "settings": {
      const vault = await findVault(api, screen.vault);
      const detail = await api.getVault(vault.address);
      const deposit = { mint: detail.depositMint, symbol: detail.depositSymbol, decimals: detail.depositDecimals };
      const update = (text: string, changes: Extract<PendingAction, { kind: "vaultUpdate" }>["changes"]) =>
        confirmButton(deps, text, { kind: "vaultUpdate", vault: vault.address, deposit, changes });
      return {
        html: settingsMessage(detail),
        keyboard: keyboard([
          [
            update(detail.depositPaused ? "▶️ Resume deposits" : "⏸ Pause deposits", { depositPaused: !detail.depositPaused }),
            update(detail.withdrawalPaused ? "▶️ Resume withdrawals" : "⏸ Pause withdrawals", { withdrawalPaused: !detail.withdrawalPaused }),
          ],
          STATUS_BUTTONS.filter((b) => b.status !== detail.status).map((b) => update(b.text, { status: b.status })),
          [button("✏️ Edit fees and limits", { kind: "editSettings", vault: vault.address })],
          [
            confirmButton(deps, "💰 Claim manager fee", { kind: "vaultClaimFee", vault: vault.address }),
            confirmButton(deps, "🗑 Close vault", { kind: "vaultClose", vault: vault.address }),
          ],
          [button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })],
        ]),
      };
    }
    case "editSettings": {
      const vault = await findVault(api, screen.vault);
      return renderForm(deps.forms.put(await createVaultForm(api, vault.address)), deps);
    }
    case "newVault":
      return renderForm(deps.forms.put(await createVaultForm(api)), deps);
    case "phoenix": {
      const vault = await findVault(api, screen.vault);
      const phoenix = await api.getPhoenix(vault.address);
      const rows: Button[][] = [];
      if (phoenix.usdcVault && phoenix.status === "none") {
        rows.push([confirmButton(deps, "🚀 Set up Phoenix", { kind: "phoenixInit", vault: vault.address })]);
      } else if (phoenix.usdcVault && phoenix.status === "registered") {
        rows.push([confirmButton(deps, "🤝 Onboard trader", { kind: "phoenixOnboard", vault: vault.address })]);
      } else if (phoenix.usdcVault && phoenix.status === "ready") {
        rows.push(
          [button("💵 Deposit USDC", { kind: "phoenixDeposit", vault: vault.address }), button("📤 Withdraw", { kind: "phoenixWithdraw", vault: vault.address })],
          [button("🆕 New order", { kind: "newOrder", vault: vault.address }), confirmButton(deps, "🧹 Sweep", { kind: "phoenixSweep", vault: vault.address })],
        );
        const symbols = [...new Set((phoenix.openOrders ?? []).map((order) => order.symbol))];
        for (const symbol of symbols) rows.push([confirmButton(deps, `✖️ Cancel all ${symbol} orders`, { kind: "phoenixCancel", vault: vault.address, symbol })]);
      }
      rows.push([button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })]);
      return { html: phoenixMessage(vault, phoenix), keyboard: keyboard(rows) };
    }
    case "phoenixDeposit":
    case "phoenixWithdraw": {
      const vault = await findVault(api, screen.vault);
      const direction = screen.kind === "phoenixDeposit" ? "deposit" : "withdraw";
      return renderForm(deps.forms.put(await createPhoenixTransferForm(api, vault.address, direction)), deps);
    }
    case "newOrder": {
      const vault = await findVault(api, screen.vault);
      return renderForm(deps.forms.put(await createOrderForm(api, vault.address)), deps);
    }
    case "trackToken": {
      const vault = await findVault(api, screen.vault);
      return renderForm(deps.forms.put(await createTrackForm(api, vault.address)), deps);
    }
    case "strategies": {
      const vault = await findVault(api, screen.vault);
      const strategies = await api.getStrategies(vault.address);
      const rows = strategies.flatMap((strategy) => {
        if (strategy.type === "dlmm") {
          const refId = deps.positions.put({ vault: vault.address, position: strategy.position });
          return [[button(`⚙️ ${pairLabel(strategy)} position`, { kind: "position", refId })]];
        }
        if (strategy.type === "jupiter" && strategy.vaultBalance === "0") {
          const action: PendingAction = { kind: "closeStrategy", vault: vault.address, strategy: strategy.address, label: `${strategy.symbol} swap strategy` };
          return [[confirmButton(deps, `🗑 Close empty ${strategy.symbol} strategy`, action)]];
        }
        return [];
      });
      return {
        html: strategiesMessage(vault, strategies),
        keyboard: keyboard([
          ...rows,
          [button("➕ Track token", { kind: "trackToken", vault: vault.address })],
          [button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })],
          [homeButton()],
        ]),
      };
    }
    case "position": {
      const { vault, strategy } = await findPosition(deps, screen.refId);
      const back = button("⬅️ Strategies", { kind: "strategies", vault: vault.address });
      const base = { vault: vault.address, position: strategy.position, pairLabel: pairLabel(strategy) };
      const removeButton = (bps: RemoveBps) => confirmButton(deps, `➖ ${bps / 100}%`, { kind: "dlmmRemove", ...base, bps });
      const rows: Button[][] = [[confirmButton(deps, "💰 Claim fees", { kind: "dlmmClaim", ...base })]];
      if (strategy.lbPair) rows.push([button("➕ Add liquidity", { kind: "addLp", refId: screen.refId })]);
      rows.push(
        REMOVE_BPS.map(removeButton),
        [confirmButton(deps, `🔁 Zap out to ${vault.depositSymbol}`, { kind: "dlmmZapOut", ...base, depositSymbol: vault.depositSymbol })],
        [confirmButton(deps, "🗑 Close position", { kind: "dlmmClose", ...base })],
        [button("🔄 Refresh", screen), back],
      );
      return { html: positionMessage(vault, strategy, Math.floor(Date.now() / 1000)), keyboard: keyboard(rows) };
    }
    case "newSwap": {
      const vault = await findVault(api, screen.vault);
      return renderForm(deps.forms.put(await createSwapForm(api, vault.address)), deps);
    }
    case "newLp": {
      const vault = await findVault(api, screen.vault);
      return renderForm(deps.forms.put(await createLpForm(api, vault.address)), deps);
    }
    case "addLp": {
      const { vault, strategy } = await findPosition(deps, screen.refId);
      if (!strategy.lbPair) throw new ScreenNotice("The API did not return this position's pool.");
      return renderForm(deps.forms.put(await createLpForm(api, vault.address, { position: strategy.position, lbPair: strategy.lbPair })), deps);
    }
    case "form":
      return renderForm(screen.formId, deps);
    case "swapQuote":
      return renderSwapQuote(screen.formId, deps);
    case "confirm": {
      const action = deps.actions.get(screen.actionId);
      if (!action) throw expired();
      const vaultAddress = actionVault(action);
      const vault = vaultAddress === undefined ? undefined : await findVault(api, vaultAddress);
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
          [
            button("✅ Confirm & send", { kind: "execute", actionId: screen.actionId }),
            button("✖️ Cancel", vault ? { kind: "vault", vault: vault.address } : { kind: "vaults" }),
          ],
        ]),
      };
    }
    default:
      throw new Error(`${screen.kind} is handled by the bot, not rendered`);
  }
}
