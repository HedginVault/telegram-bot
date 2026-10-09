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
| `/holdings <vault>` | Vault overview: live value vs last NAV, per-token exposure, open LP and perps positions |
| `/strategies <vault>` | Open Jupiter, Meteora DLMM, and Phoenix strategies |
| `/nav <vault>` | The last 10 posted NAVs, newest first, with admin overrides flagged |
| `/requests <vault>` | Queued deposits and withdrawals, and whether each can settle yet |
| `/history <vault>` | The last 10 closed strategies with realized PnL per token |
| `/phoenix <vault>` | Phoenix perps: setup step, margin, positions, open orders |
| `/settings <vault>` | Fees, limits, status, pause flags, pending totals |

`<vault>` is a vault address or its number from `/vaults`. The vault screen has a button for
each of these. History reads fail with `HistoryUnavailable` on a server without a history
database.

API responses are checked against the documented V1 contract. A response that does not
match is reported as `contract_mismatch` instead of being shown half-parsed.

## Trading

| Where | What you set | API builder |
| --- | --- | --- |
| Vault → 💱 Swap | Buy or sell · a held token or a pasted contract address · amount (`1.5`, `25%`, `max`) · slippage (0.5 / 1 / 3% or typed, up to the protocol's 3%) | `jupiter/swap` |
| Vault → ➕ New LP | Pool (pasted address, or symbol search sorted by TVL) · side (X only / both / Y only) · shape (Spot / Curve / Bid-Ask) · range preset per side or typed min and max price · amount of each token the range can hold | `dlmm/open` (+ `dlmm/extend` continuations past 70 bins) |
| DLMM position → ➕ Add liquidity | Shape · amount of each token | `dlmm/add` |
| DLMM position | 💰 Claim fees | `dlmm/claim-fee` |
| DLMM position | ➖ 25% / 50% / 100% | `dlmm/remove` |
| DLMM position | 🔁 Zap out | `dlmm/zap-out` (+ `dlmm/zap-out/swap` continuations), 100 bps |
| DLMM position | 🗑 Close position (removes all liquidity, claims fees) | `dlmm/close` |
| Vault → ➕ New LP | Pool · range (up to 70 bins) · 🫙 Empty position | `dlmm/initialize` |
| Strategies | 🗑 Close empty strategy | `strategy/close` |
| Strategies → ➕ Track token | A pasted contract address (Jupiter verification shown) | `jupiter/initialize` |
| Vault → 📈 Phoenix | 🚀 Set up Phoenix (shown when the vault has no Phoenix strategy) | `phoenix/initialize` |
| Vault → 📈 Phoenix | 🤝 Onboard trader (shown after setup) | `onboardPhoenix` (`phoenix/onboard`) |
| Vault → 📈 Phoenix | 💵 Deposit USDC · 📤 Withdraw: amount (`1.5`, `25%`, `max`) | `phoenix/deposit`, `phoenix/withdraw` |
| Vault → 📈 Phoenix → 🆕 New order | Market (button or typed symbol) · long or short · size (`0.5`) · market with slippage (0.5 / 1 / 3% or typed, up to 20%) or limit with price and post-only · reduce-only | `phoenix/order` |
| Vault → 📈 Phoenix | ✖️ Cancel all orders on one market · 🧹 Sweep a queued withdrawal | `phoenix/cancel` (`orders: "all"`), `phoenix/sweep` |
| Vault → ⚙️ Settings | ⏸/▶️ deposits or withdrawals · status Normal / Reduce-only / Paused | `vault/update` (one field) |
| Vault → ⚙️ Settings → ✏️ Edit fees and limits | Fees in % · deposit cap (or `none`) · min deposit · min withdrawal shares | `vault/update` (only the changed fields) |
| Vault → ⚙️ Settings | 💰 Claim manager fee · 🗑 Close vault | `vault/claim-fee`, `vault/close` |
| Vaults → ✨ Create vault | Name (at most 32 bytes) · deposit token (USDC, or a pasted mint) · fees in % · cap · min deposit · min withdrawal shares | `vault/initialize`; the new address comes back as `created.vault` |

Pausing the vault, closing it, and closing a DLMM position show a plain-words warning on the
confirm screen. A pasted deposit mint is looked up through a vault the key already manages, so a
manager's first vault must use USDC.

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
  Phoenix onboarding is the one exception, checked by the SDK's narrower policy: a single
  transaction that calls only the Phoenix program and that Phoenix co-signs on submit.
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

### Key scopes per feature

Every action needs `send` plus its own builder name. When a key lacks one, the bot names the
missing action so the manager can ask the admin for it.

| Feature | Key actions |
| --- | --- |
| Any screen or command | `read` |
| Swap | `jupiter/swap` |
| Track token | `jupiter/initialize` |
| New LP position | `dlmm/open`, plus `dlmm/extend` for ranges over 70 bins |
| Empty position | `dlmm/initialize` |
| Add liquidity · claim fees · remove | `dlmm/add` (+ `dlmm/add-range`), `dlmm/claim-fee`, `dlmm/remove` |
| Zap out | `dlmm/zap-out`, `dlmm/zap-out/swap` |
| Close position · close empty strategy | `dlmm/close`, `strategy/close` |
| Phoenix setup | `phoenix/initialize`, then `phoenix/onboard` |
| Phoenix funds and trading | `phoenix/deposit`, `phoenix/withdraw`, `phoenix/order`, `phoenix/cancel`, `phoenix/sweep` |
| Settings | `vault/update`, `vault/claim-fee`, `vault/close` |
| Create vault | `vault/initialize`, on a key not limited to specific vaults |

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

## Deploy

A push to `main` builds `ghcr.io/hedginvault/telegram-bot`, runs typecheck, tests, and build,
then rolls out one pod to namespace `hedgevault-prod` (`.github/workflows/build-deploy.yml`).
The bot long-polls Telegram, so it has no Service or Ingress. The Deployment uses the
`Recreate` strategy because Telegram accepts one poller per token.

The wallet store lives on PersistentVolumeClaim `telegram-bot-data` (`k8s/pvc.yaml`,
`local-path`, mounted at `/data`). Deleting that claim deletes every stored wallet. On this
single-node cluster the store and `WALLET_ENCRYPTION_KEY` sit on the same host, so the
"keep them apart" advice in Custody above does not hold there; back up the volume and the
key separately.

One-time setup, done by an operator:

1. GitHub repository secret `KUBECONFIG` (base64 kubeconfig, same as the other services) and
   a `production` Environment.
2. The runtime Secret. The workflow checks it exists and never creates it:

   ```sh
   kubectl -n hedgevault-prod create secret generic telegram-bot-secrets \
     --from-literal=TELEGRAM_BOT_TOKEN='<botfather token>' \
     --from-literal=WALLET_ENCRYPTION_KEY="$(openssl rand -hex 32)"
   ```

   Add `--from-literal=ALLOWED_TELEGRAM_USER_IDS=<id>,<id>` to keep the bot private. To keep
   wallets from a local run, reuse its `WALLET_ENCRYPTION_KEY` and copy `data/wallets.json`
   into the volume; the store does not open under a different key.
3. Stop any local copy before the first rollout; two pollers on one token conflict.
