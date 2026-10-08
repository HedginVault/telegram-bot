# Hedge Vault Telegram bot

A Telegram bot, built with [Telegraf](https://github.com/telegraf/telegraf), that manages
Hedge Vault vaults through the manager bot API (`/api/external/v1`). It serves two purposes:

- Demo: show how a bot reads and operates a vault.
- API check: exercise the external API the way an outside partner would.

The API contract lives in `app/docs/manager-api.md` in the sibling `app/` repository.

## Current scope

Read-only scaffold. `/vaults` lists the vaults the API key can manage. The bot holds no
Solana signing key yet, so it cannot move funds.

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
