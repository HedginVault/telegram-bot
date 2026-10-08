import type { HedgeClient, Strategy, VaultSummary } from "@hedginvault/sdk";
import { type PendingAction, REMOVE_BPS, type RemoveBps } from "./actions";
import { type Form, type FormDeps, createLpForm, createSwapForm, renderForm, renderSwapQuote } from "./forms";
import { confirmMessage, holdingsMessage, positionMessage, strategiesMessage, vaultMessage, vaultsMessage } from "./messages";
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
} from "./ui";

export interface ScreenDeps extends FormDeps {
  positions: IdStore<PositionRef>;
  forms: IdStore<Form>;
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
          ...vaults.map((vault, index) => [button(`${index + 1}. ${vault.name}`, { kind: "vault", vault: vault.address })]),
          [button("🔄 Refresh", screen)],
        ]),
      };
    }
    case "vault": {
      const vault = await findVault(api, screen.vault);
      const trade: Button[] = [button(deps.trading ? "💱 Swap" : "💱 Quote a swap", { kind: "newSwap", vault: vault.address })];
      if (deps.trading) trade.push(button("➕ New LP position", { kind: "newLp", vault: vault.address }));
      return {
        html: vaultMessage(vault),
        keyboard: keyboard([
          [button("📊 Holdings", { kind: "holdings", vault: vault.address }), button("🧩 Strategies", { kind: "strategies", vault: vault.address })],
          trade,
          [homeButton()],
        ]),
      };
    }
    case "holdings": {
      const vault = await findVault(api, screen.vault);
      return {
        html: holdingsMessage(vault, await api.getHoldings(vault.address)),
        keyboard: keyboard([[button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton()]]),
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
        keyboard: keyboard([...rows, [button("🔄 Refresh", screen), button("⬅️ Back", { kind: "vault", vault: vault.address })], [homeButton()]]),
      };
    }
    case "position": {
      const { vault, strategy } = await findPosition(deps, screen.refId);
      const back = button("⬅️ Strategies", { kind: "strategies", vault: vault.address });
      if (!deps.trading) return { html: positionMessage(vault, strategy, false), keyboard: keyboard([[button("🔄 Refresh", screen), back]]) };
      const base = { vault: vault.address, position: strategy.position, pairLabel: pairLabel(strategy) };
      const removeButton = (bps: RemoveBps) => confirmButton(deps, `➖ ${bps / 100}%`, { kind: "dlmmRemove", ...base, bps });
      const rows: Button[][] = [[confirmButton(deps, "💰 Claim fees", { kind: "dlmmClaim", ...base })]];
      if (strategy.lbPair) rows.push([button("➕ Add liquidity", { kind: "addLp", refId: screen.refId })]);
      rows.push(
        REMOVE_BPS.map(removeButton),
        [confirmButton(deps, `🔁 Zap out to ${vault.depositSymbol}`, { kind: "dlmmZapOut", ...base, depositSymbol: vault.depositSymbol })],
        [button("🔄 Refresh", screen), back],
      );
      return { html: positionMessage(vault, strategy, true), keyboard: keyboard(rows) };
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
    case "formOp":
    case "execute":
      throw new Error(`${screen.kind} is handled by the bot, not rendered`);
  }
}
