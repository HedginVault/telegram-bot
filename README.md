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
verified are flagged on the form and the confirm screen. Token lookups need app PR #18.

### Getting the keypair file

To use the wallet that already manages your vault (for example Phantom):

1. In the wallet, open the account's **Show private key** and copy it.
2. Convert it without it ever appearing on screen:
   ```sh
   mkdir -p keys && chmod 700 keys
   pbpaste | yarn -s import-key keys/manager.json
   ```
   The command saves an owner-only file and prints only the public key. It refuses to
   overwrite a file, and inside this repository it only writes git-ignored paths (`keys/` is
   ignored).
3. Clear the clipboard, check the printed public key is the vault's manager, and set
   `MANAGER_KEYPAIR_PATH=keys/manager.json`.

The program has no instruction to change a vault's authority, so this key controls the vault
permanently. Keep the file only on the machine that runs the bot.

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

Opening a position reads the pool's active bin from `GET /dlmm/pools/{lbPair}` (deployed).

The keypair holds real funds on mainnet. Use a dedicated demo vault with its own authority
key and a small balance. Never commit the keypair file.

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
