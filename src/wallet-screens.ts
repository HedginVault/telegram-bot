import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { escapeHtml } from "./messages";
import { type Button, type RenderedScreen, type WalletScreen, button, homeButton, keyboard, walletButton } from "./ui";
import { API_KEY_PATTERN, MAX_WALLETS_PER_USER, WalletError, type WalletStore, type WalletSummary, parseSecretKey } from "./wallets";

/** A secret the bot is waiting for the user to paste. */
export type WalletInput = { kind: "privateKey" } | { kind: "apiKey"; walletId: string };

export type WalletResult =
  | { kind: "show"; screen: RenderedScreen }
  | { kind: "ask"; prompt: string; input: WalletInput }
  /** Send `secretHtml` as its own short-lived message, then show `screen`. */
  | { kind: "reveal"; secretHtml: string; screen: RenderedScreen };

export const EXPORT_VISIBLE_SECONDS = 60;

const short = (publicKey: string) => `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
const code = (text: string) => `<code>${escapeHtml(text)}</code>`;

const MENU_ROWS = (active: WalletSummary | undefined): Button[][] => [
  ...(active ? [[button("🔑 Export private key", { kind: "walletExport" }), button(active.hasApiKey ? "🔐 Replace API key" : "🔐 Add API key", { kind: "walletApiKey" })]] : []),
  [button("📥 Import wallet", { kind: "walletImport" }), button("✨ New wallet", { kind: "walletNew" })],
  [button("🔀 My wallets · switch", { kind: "wallets" }), ...(active?.hasApiKey ? [homeButton()] : [])],
];

function walletMenu(active: WalletSummary | undefined, notice?: string): RenderedScreen {
  const lines = notice ? [notice, ""] : [];
  if (!active) {
    lines.push(
      "👛 <b>Wallet</b>",
      "",
      "Add the wallet that manages your vault to start.",
      "📥 <b>Import</b> pastes its private key. ✨ <b>New</b> creates a fresh wallet; it manages no vault until an admin whitelists it.",
    );
  } else {
    lines.push(`👛 <b>Active wallet</b> · ${active.origin}`, code(active.publicKey), "");
    lines.push(
      active.hasApiKey
        ? "API key set. Vaults, balances, and trades use this wallet."
        : "⚠️ <b>No API key yet.</b> Ask a Hedge Vault admin for an API key issued to this wallet's address, then tap 🔐 Add API key.",
    );
  }
  return { html: lines.join("\n"), keyboard: keyboard(MENU_ROWS(active)) };
}

function walletList(store: WalletStore, userId: number): RenderedScreen {
  const wallets = store.list(userId);
  const active = store.active(userId);
  const rows = wallets.map((wallet) => [
    button(`${wallet.id === active?.id ? "✅ " : ""}${short(wallet.publicKey)} · ${wallet.origin}${wallet.hasApiKey ? "" : " · no API key"}`, { kind: "walletUse", walletId: wallet.id }),
    button("🗑", { kind: "walletRemove", walletId: wallet.id }),
  ]);
  return {
    html: [
      `🔀 <b>My wallets</b> · ${wallets.length} of ${MAX_WALLETS_PER_USER}`,
      "",
      "Tap a wallet to make it <b>active</b>. Vaults, balances, and trades use the active wallet.",
      "🗑 deletes the bot's copy of that private key. Export it first if you have no other copy.",
    ].join("\n"),
    keyboard: keyboard([...rows, [walletButton()]]),
  };
}

/** Renders or applies one wallet button. Every lookup is scoped to `userId`, so a forged id cannot reach another user's wallet. */
export function walletScreen(screen: WalletScreen, userId: number, store: WalletStore): WalletResult {
  switch (screen.kind) {
    case "wallet":
      return { kind: "show", screen: walletMenu(store.active(userId)) };
    case "wallets":
      return { kind: "show", screen: walletList(store, userId) };
    case "walletNew": {
      const { wallet } = store.add(userId, Keypair.generate(), "generated");
      return {
        kind: "show",
        screen: walletMenu(wallet, "✨ <b>New wallet created.</b> Tap 🔑 Export private key and save it somewhere safe: if this bot loses its data, that copy is the only way back in."),
      };
    }
    case "walletImport":
      return {
        kind: "ask",
        input: { kind: "privateKey" },
        prompt: "Paste the private key (base58 as Phantom or Solflare show it, or a Solana CLI JSON array). The bot deletes your message right away.",
      };
    case "walletApiKey": {
      const active = store.active(userId);
      if (!active) return { kind: "show", screen: walletMenu(undefined) };
      return {
        kind: "ask",
        input: { kind: "apiKey", walletId: active.id },
        prompt: `Paste the API key (hv1_…) an admin issued for ${short(active.publicKey)}. The bot deletes your message right away.`,
      };
    }
    case "walletExport": {
      const active = store.active(userId);
      if (!active) return { kind: "show", screen: walletMenu(undefined) };
      return {
        kind: "show",
        screen: {
          html: [
            `🔑 <b>Export private key</b> of ${code(active.publicKey)}`,
            "",
            "Anyone who sees this key controls the wallet and every vault it manages, forever.",
            `The bot shows it for ${EXPORT_VISIBLE_SECONDS} seconds, then deletes the message. Do not screenshot it in a shared place.`,
          ].join("\n"),
          keyboard: keyboard([[button("👁 Show private key", { kind: "walletReveal" })], [walletButton()]]),
        },
      };
    }
    case "walletReveal": {
      const active = store.active(userId);
      if (!active) return { kind: "show", screen: walletMenu(undefined) };
      const secret = bs58.encode(store.keypair(userId, active.id).secretKey);
      return {
        kind: "reveal",
        secretHtml: `🔑 Private key of ${short(active.publicKey)} (tap to copy, deleted in ${EXPORT_VISIBLE_SECONDS}s):\n<tg-spoiler><code>${secret}</code></tg-spoiler>`,
        screen: walletMenu(active),
      };
    }
    case "walletUse": {
      const wallet = store.use(userId, screen.walletId);
      return { kind: "show", screen: walletMenu(wallet, `✅ Active wallet is now ${code(wallet.publicKey)}.`) };
    }
    case "walletRemove": {
      const wallet = store.list(userId).find((w) => w.id === screen.walletId);
      if (!wallet) return { kind: "show", screen: walletList(store, userId) };
      return {
        kind: "show",
        screen: {
          html: [
            `🗑 <b>Remove</b> ${code(wallet.publicKey)}?`,
            "",
            "The bot deletes its copy of this private key and API key. Funds stay on chain, but without your own copy of the key you lose access to them and to every vault this wallet manages.",
          ].join("\n"),
          keyboard: keyboard([[button("🗑 Yes, remove it", { kind: "walletRemoved", walletId: wallet.id })], [button("✖️ Keep it", { kind: "wallets" })]]),
        },
      };
    }
    case "walletRemoved":
      store.remove(userId, screen.walletId);
      return { kind: "show", screen: walletList(store, userId) };
  }
}

/**
 * Applies a pasted secret. `checkApiKey` proves the API accepts the key before it is stored;
 * the API binds each key to one wallet and the SDK refuses to sign for any other payer.
 */
export async function applyWalletText(
  input: WalletInput,
  text: string,
  userId: number,
  store: WalletStore,
  checkApiKey: (apiKey: string) => Promise<void>,
): Promise<RenderedScreen> {
  switch (input.kind) {
    case "privateKey": {
      const { wallet, existed } = store.add(userId, parseSecretKey(text), "imported");
      return walletMenu(wallet, existed ? "That wallet was already on your list; it is now active." : "📥 <b>Wallet imported.</b>");
    }
    case "apiKey": {
      const apiKey = text.trim();
      if (!API_KEY_PATTERN.test(apiKey)) throw new WalletError("An API key looks like hv1_<id>_<secret>.");
      await checkApiKey(apiKey);
      store.setApiKey(userId, input.walletId, apiKey);
      return walletMenu(store.active(userId), "🔐 <b>API key saved.</b>");
    }
  }
}
