# Hedge Vault Telegram bot

A Telegram bot, built with [Telegraf](https://github.com/telegraf/telegraf), that manages
Hedge Vault vaults through the manager bot API (`/api/external/v1`). It serves two purposes:

- Demo: show how a bot reads and operates a vault.
- API check: exercise the external API the way an outside partner would.

The API contract lives in `app/docs/manager-api.md` in the sibling `app/` repository.

## Wallets

The bot is public: anyone can open it in a private chat (groups are ignored, because keys are
pasted into the chat). Each Telegram user keeps their own wallets under `/wallet` (👛 Wallet):

| Button | What it does |
| --- | --- |
| 📥 Import wallet | Paste a private key (base58 as Phantom/Solflare export it, or a Solana CLI JSON array). The bot deletes the message at once. |
| ✨ New wallet | Creates a fresh keypair. It manages no vault until an admin whitelists it and it creates one. |
| 🔐 Add API key | Paste the `hv1_…` key an admin issued for this wallet's address. The bot checks it against the API, deletes the message, and stores it. |
| 🔑 Export private key | After a warning, sends the key as a protected spoiler message that deletes itself after 60 seconds. |
| 🔀 My wallets · switch | Lists up to 10 wallets; tap one to make it active, 🗑 to delete the bot's copy (asks first). |

Vault screens, balances, and trades always use the **active** wallet and its API key. Each API
key is bound to one manager wallet, so every wallet needs its own key from the admin dashboard.
Switching wallets expires form and confirm buttons made for the previous one. A private key
pasted anywhere else is deleted too.

### Custody

The bot is a hot wallet. Private keys and API keys are stored AES-256-GCM encrypted in
`WALLET_STORE_PATH` (default `data/wallets.json`, owner-only, git-ignored). Each value is bound
to its Telegram user, wallet, and field, so a value copied into another slot does not decrypt.
The master key is `WALLET_ENCRYPTION_KEY` (`openssl rand -hex 32`). The bot refuses to start if
the store does not open with it.

Anyone with both the store file and the master key controls every stored wallet, and vault
authority can never be moved on chain. Keep the two apart, back both up, and never log them.
Losing either loses every generated wallet that its user did not export. Telegram chats are not
end-to-end encrypted: a pasted key passes through Telegram's servers before the bot deletes it.

## Commands

`/start` opens the vaults (or the wallet menu until the active wallet has an API key). The
commands below also work.

| Command | What it shows |
| --- | --- |
| `/wallet` | Import, create, export, or switch wallets |
| `/vaults` | Numbered list of vaults the active wallet manages |
| `/holdings <vault>` | Live value, last NAV, and per-token exposure |
| `/strategies <vault>` | Open Jupiter, Meteora DLMM, and Phoenix strategies |

`<vault>` is a vault address or its number from `/vaults`.

API responses are checked against the documented V1 contract. A response that does not
match is reported as `contract_mismatch` instead of being shown half-parsed.

## Trading

| Where | What you set | API builder |
| --- | --- | --- |
| Vault → 💱 Swap | Buy or sell · a held token or a pasted contract address · amount (`1.5`, `25%`, `max`) · slippage (0.5 / 1 / 3% or typed, up to the protocol's 3%) | `jupiter/swap` |
| Vault → ➕ New LP position | Pool (pasted address or symbol search) · shape (Spot / Curve / Bid-Ask) · min and max price (or ±1 / 5 / 10%) · amount of each token | `dlmm/open` (+ `dlmm/extend` continuations past 70 bins) |
| DLMM position → ➕ Add liquidity | Shape · amount of each token | `dlmm/add` |
| DLMM position | 💰 Claim fees | `dlmm/claim-fee` |
| DLMM position | ➖ 25% / 50% / 100% | `dlmm/remove` |
| DLMM position | 🔁 Zap out | `dlmm/zap-out` (+ `dlmm/zap-out/swap` continuations), 100 bps |
| Strategies | 🗑 Close empty strategy | `strategy/close` |

Fields you type into ask with a prompt; answer in the chat, or send `/cancel`. Prices are the
pool's quote token per base token; the bot converts them to bins and shows the actual edge
prices, bin count, and which tokens the range can hold. Pasted tokens that Jupiter has not
verified are flagged on the form and the confirm screen.

Every action shows a confirm screen first. Then the bot builds, checks, signs, sends, and
polls each transaction, editing one message with live progress and Solscan links.

Safety rules the bot enforces:

- **Inspect before signing.** Every transaction in a batch must be v0, paid by the manager
  key, already signed by any other required signer, and call only the Hedge Vault program,
  ComputeBudget, Associated Token Account, Meteora DLMM, or Jupiter at the top level. The
  priority fee is capped at 100,000 microLamports per CU. Anything else is refused unsigned.
- **One shot.** A confirm button works once. Only one action per user runs at a time.
- **No blind retries.** An ambiguous send is polled by its receipt. The bot never rebuilds
  after it, because a rebuild could execute the action twice. If it cannot tell, it says so
  and links the transaction.

Opening a position reads the pool's active bin from `GET /dlmm/pools/{lbPair}` (deployed).

Stored keys control real funds on mainnet. Never commit `data/`, `.env`, or a backup of either.

## SDK

API calls, transaction inspection, signing, and execution come from `@hedginvault/sdk` in
the sibling `sdk/` repository. The bot installs it from `vendor/hedginvault-sdk.tgz` so it
builds without the sibling checkout. After changing the SDK, run `yarn sdk:update` and
commit the new tarball, `package.json`, and `yarn.lock`. The tarball name carries a content
hash because Yarn 1 caches `file:` tarballs by name and version and would otherwise keep
installing the old build.

The API checker moved to the SDK: run `hedge-check-api` there.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN` and `WALLET_ENCRYPTION_KEY`
   (`openssl rand -hex 32`). Optional: `WALLET_STORE_PATH`, `HEDGE_API_BASE_URL`,
   `HEDGE_PROGRAM_ID`, and `ALLOWED_TELEGRAM_USER_IDS`.
3. Managers get their API keys from an admin (dashboard, with the `read` action and the
   builder actions they need), then add them in the bot.

```sh
yarn install --frozen-lockfile
yarn dev        # watch mode
yarn test
yarn build && yarn start
```

Leave `ALLOWED_TELEGRAM_USER_IDS` unset for a public bot. Set it (comma-separated numeric
Telegram user IDs) to limit replies to those users during a staged rollout.

## Safety

`HEDGE_API_BASE_URL` defaults to production (`https://hedgin.xyz`), which runs on
Solana mainnet. Reads are harmless. Any future command that signs or sends a transaction
moves real funds. Never commit `.env`, `data/`, API keys, or keypair files.
