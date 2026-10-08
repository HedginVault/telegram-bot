# Hedge Vault Telegram bot

A Telegram bot, built with [Telegraf](https://github.com/telegraf/telegraf), that manages
Hedge Vault vaults through the manager bot API (`/api/external/v1`). It serves two purposes:

- Demo: show how a bot reads and operates a vault.
- API check: exercise the external API the way an outside partner would.

The API contract lives in `app/docs/manager-api.md` in the sibling `app/` repository.

## Commands

Without `MANAGER_KEYPAIR_PATH` the bot is read-only and cannot move funds. `/start` opens a
button menu; the commands below also work.

| Command | What it shows |
| --- | --- |
| `/vaults` | Numbered list of vaults the API key can manage |
| `/holdings <vault>` | Live value, last NAV, and per-token exposure |
| `/strategies <vault>` | Open Jupiter, Meteora DLMM, and Phoenix strategies |
| `/quote <vault> <inputMint> <outputMint> <amount> [slippageBps]` | Jupiter quote; one mint must be the vault deposit mint |

`<vault>` is a vault address or its number from `/vaults`. `<amount>` is in base units
(1 USDC = `1000000`). Slippage defaults to 50 bps.

API responses are checked against the documented V1 contract. A response that does not
match is reported as `contract_mismatch` instead of being shown half-parsed.

## Trading

Trading is off unless `MANAGER_KEYPAIR_PATH` points to a Solana CLI keypair file (a JSON
array of 64 numbers). That key must be the vault's current authority and the API key's
manager. With it set, these buttons appear:

| Where | Button | API builder |
| --- | --- | --- |
| Quote result | ⚡ Swap | `jupiter/swap`, 50 bps slippage |
| DLMM position | 💰 Claim fees | `dlmm/claim-fee` |
| DLMM position | ➖ 25% / 50% / 100% | `dlmm/remove` |
| DLMM position | 🔁 Zap out | `dlmm/zap-out` (+ `dlmm/zap-out/swap` continuations), 100 bps |
| Strategies | 🗑 Close empty strategy | `strategy/close` |

Every action shows a confirm screen first. Then the bot builds, checks, signs, sends, and
polls each transaction, editing one message with live progress and Solscan links.

Safety rules the bot enforces:

- **Inspect before signing.** Every transaction in a batch must be v0, paid by the manager
  key, already signed by any other required signer, and call only the Hedge Vault program,
  ComputeBudget, Associated Token Account, Meteora DLMM, or Jupiter at the top level. The
  priority fee is capped at 100,000 microLamports per CU. Anything else is refused unsigned.
- **One shot.** A confirm button works once. Only one action runs at a time.
- **No blind retries.** An ambiguous send is polled by its receipt. The bot never rebuilds
  after it, because a rebuild could execute the action twice. If it cannot tell, it says so
  and links the transaction.

Opening a new DLMM position is not supported: V1 pool search does not return the pool's
active bin, which a safe range needs.

The keypair holds real funds on mainnet. Use a dedicated demo vault with its own authority
key and a small balance. Never commit the keypair file.

## SDK

API calls, transaction inspection, signing, and execution come from `@hedginvault/sdk` in
the sibling `sdk/` repository. The bot installs it from `vendor/hedginvault-sdk.tgz` so it
builds without the sibling checkout. After changing the SDK, run `yarn sdk:update` and
commit the new tarball and `yarn.lock`.

The API checker moved to the SDK: run `hedge-check-api` there.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create a manager API key in the admin dashboard with the `read` action.
3. Find your numeric Telegram user ID (for example with @userinfobot).
4. Copy `.env.example` to `.env` and fill in the values.

```sh
yarn install --frozen-lockfile
yarn dev        # watch mode
yarn test
yarn build && yarn start
```

Only user IDs listed in `ALLOWED_TELEGRAM_USER_IDS` get replies. Everyone else is ignored.

## Safety

`HEDGE_API_BASE_URL` defaults to production (`https://hedgin.xyz`), which runs on
Solana mainnet. Reads are harmless. Any future command that signs or sends a transaction
moves real funds: use a dedicated demo vault with its own manager key and a small balance.
Never commit `.env`, API keys, or keypair files.
