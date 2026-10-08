# Hedge Vault Telegram bot

A Telegram bot, built with [Telegraf](https://github.com/telegraf/telegraf), that manages
Hedge Vault vaults through the manager bot API (`/api/external/v1`). It serves two purposes:

- Demo: show how a bot reads and operates a vault.
- API check: exercise the external API the way an outside partner would.

The API contract lives in `app/docs/manager-api.md` in the sibling `app/` repository.

## Commands

Read-only. The bot holds no Solana signing key, so it cannot move funds.

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

## API checker

`yarn check-api` probes the V1 API with the key in `.env` and prints a pass/fail table with
response times. It exits non-zero when any check fails.

- Auth: missing, wrong, and malformed keys return 401.
- Contract: `/vaults`, holdings, strategies, quotes, and pool search match the documented shapes for up to 3 vaults.
- Validation: bad addresses, slippage, amounts, and mint pairs return 400; unknown routes 404.
- Error bodies use `{ error: { code, message } }` and never leak provider logs or stack traces.

`yarn check-api --build` also asks the API to build one unsigned 0.01-token swap per vault
and checks the transaction and ticket. Nothing is signed or sent, so no funds move. It needs
a key with the `jupiter/swap` action.

The checker sends about 12 requests per vault and checks at most 3 vaults to stay under the
API's 60 requests per minute per IP.

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
