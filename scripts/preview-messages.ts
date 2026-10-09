/**
 * Prints the redesigned screens as Telegram HTML plus their button rows, from test fixtures.
 * Run: yarn tsx scripts/preview-messages.ts
 */
import type { HedgeClient } from "@hedginvault/sdk";
import type { PendingAction } from "../src/actions";
import { type Form, applyFormOp, applyFormText, createLpForm, renderForm } from "../src/forms";
import { type ScreenDeps, renderScreen } from "../src/screens";
import { type PositionRef, type RenderedScreen, createIdStore } from "../src/ui";
import {
  POOL,
  VAULT,
  holdings,
  navHistory,
  phoenixReady,
  pool,
  poolSearch,
  quote,
  requestQueue,
  strategies,
  strategyHistory,
  vaultDetail,
  vaultSummary,
} from "../test/fixtures";

const refuse = async (): Promise<never> => {
  throw new Error("the preview never builds or sends");
};
const api: HedgeClient = {
  listVaults: async () => [vaultSummary, { ...vaultSummary, name: "Second", status: "reduceOnly", totalAssets: "51673" }],
  getVault: async () => vaultDetail,
  getHoldings: async () => holdings,
  getStrategies: async () => strategies,
  getNavHistory: async () => navHistory,
  getRequests: async () => requestQueue,
  getStrategyHistory: async () => strategyHistory,
  getPhoenix: async () => phoenixReady,
  getQuote: async () => quote,
  searchPools: async () => poolSearch,
  getToken: refuse,
  getPool: async () => pool,
  execute: refuse,
  onboardPhoenix: refuse,
  build: refuse,
  send: refuse,
  status: refuse,
};
const deps: ScreenDeps = { api, forms: createIdStore<Form>(), actions: createIdStore<PendingAction>(), positions: createIdStore<PositionRef>() };

function print(title: string, screen: RenderedScreen): void {
  console.log(`\n===== ${title} =====\n${screen.html}\n----- buttons -----`);
  for (const row of screen.keyboard.inline_keyboard) console.log(row.map((b) => `[${b.text}]`).join(" "));
}

async function main(): Promise<void> {
  print("1. Vault list", await renderScreen({ kind: "vaults" }, deps));
  print("2. Vault overview", await renderScreen({ kind: "vault", vault: VAULT }, deps));
  print("3. Strategies", await renderScreen({ kind: "strategies", vault: VAULT }, deps));

  const formId = deps.forms.put(await createLpForm(api, VAULT));
  print("4a. LP form before a search", await renderForm(formId, deps));
  await applyFormText(formId, "pool", "sol", deps);
  print("4b. Pool picker", await renderForm(formId, deps));
  await applyFormOp(formId, { op: "pool", index: 0 }, deps);
  print("5a. Position setup, both sides", await renderForm(formId, deps));
  await applyFormText(formId, "amountY", "50%", deps);
  await applyFormOp(formId, { op: "lpSide", index: 0 }, deps);
  print("5b. Position setup, SOL only", await renderForm(formId, deps));
  await applyFormOp(formId, { op: "lpSide", index: 2 }, deps);
  await applyFormText(formId, "amountY", "50%", deps);
  print("5c. Position setup, USDC only", await renderForm(formId, deps));
  await applyFormText(formId, "minPrice", "120", deps);
  print("5d. Position setup, custom min", await renderForm(formId, deps));
  print("5e. Add liquidity", await renderForm(deps.forms.put(await createLpForm(api, VAULT, { position: "Pos1111111111111111111111111111111111111111", lbPair: POOL })), deps));

  const review = await applyFormOp(formId, { op: "review" }, deps);
  if (review.kind === "show") print("6a. Confirm dlmmOpen", await renderScreen(review.screen, deps));
  const usdc = { mint: holdings.depositToken.mint, symbol: "USDC", decimals: 6 };
  const sol = { mint: pool.tokenX.mint, symbol: "SOL", decimals: 9 };
  const swap: PendingAction = { kind: "swap", vault: VAULT, input: usdc, output: sol, amountBaseUnits: "1000000", slippageBps: 50, unverified: true };
  print("6b. Confirm swap", await renderScreen({ kind: "confirm", actionId: deps.actions.put(swap) }, deps));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
