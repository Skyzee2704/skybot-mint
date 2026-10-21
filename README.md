# SkyBOT Mint

Multi-user NFT mint desk (web + Telegram Mini App). **Start here:** [DEPLOY.md](DEPLOY.md) (Vercel + Railway/Render + Neon, in Indonesian) and [SECURITY.md](SECURITY.md) (custody + threat model).

- Auth: Privy (email/Google; Telegram in the Mini App). Wallets: Privy embedded/server wallets. SkyBOT never stores or accepts raw private keys.
- Telegram ↔ dashboard linking: Settings → deep link `https://t.me/MyTradeSkyBOT?start=link_<code>`, or `/link` in the bot and paste the code. `/unlink` or the Settings button removes it.
- DB: Postgres via `DATABASE_URL`, SQLite fallback locally. Telegram: webhook when `PUBLIC_API_URL` + `TELEGRAM_WEBHOOK_SECRET` are set, polling otherwise.

> The sections below describe the mint engine (resolver, eligibility, chains). Notes about a master password or keystore are from the old single-user version and no longer apply.


Self-hosted dashboard + API (+ optional Telegram bot) for minting NFTs from **OpenSea drops (SeaDrop)** and **any other mint contract**, by pasting an OpenSea link, a collection slug, or a contract address.

- **server/** — TypeScript, Fastify, ethers v6. Resolver, encrypted keystore, eligibility, simulation, in-process scheduler/worker, Telegram bot (grammY).
- **web/** — Next.js 16 dashboard (Mint, Wallets, Jobs, Settings). It proxies `/api/*` to the server.

> Real money. Every spend path goes **preview → simulation → typed confirmation phrase** (`MINT n`, `FUND n`, `SWEEP n TO 0x…`). Start with tiny amounts. Spend caps are optional (Settings, default off).

## Quick start

```bash
npm install                      # Node 20+, from the repo root (installs both workspaces)
cp .env.example .env             # optional; everything has defaults
npm test                         # 41 unit tests
npm run build

# terminal 1 — API on 127.0.0.1:4000 (loads private RPCs from a separate secrets file)
ENV_FILES=/workspace/secrets/rpc.env npm run start:server
# terminal 2 — dashboard on http://localhost:3000
npm run start:web
```

For development, `npm run dev:server` and `npm run dev:web` give you hot reload.

Read-only network check: `ENV_FILES=/workspace/secrets/rpc.env npm run smoke`. It checks chain IDs on all chains, SeaDrop deployment, and resolves a SeaDrop drop and a generic contract. It never signs anything.

Open http://localhost:3000. On first launch you create the **master password**. It encrypts every key and **cannot be recovered**.

## Deployment on this box (pm2)

Both processes run under [pm2](https://pm2.keymetrics.io/) and keep running after the shell exits. Data lives outside the repo in `/workspace/nft-mint-bot-data` (mode 700, `db.json` 600). Secrets are loaded from `ENV_FILES=/workspace/secrets/rpc.env` and the process environment.

```bash
cd /workspace/nft-mint-bot
npm run build                                          # after code changes
bash -lc 'pm2 start ecosystem.config.cjs && pm2 save'  # first start; login shell so OPENSEA/ETHERSCAN keys are in env
pm2 ls                                                  # status
pm2 logs nft-mint-api --lines 100                       # API + worker + Telegram logs (secrets redacted)
pm2 logs nft-mint-web
bash -lc 'pm2 restart ecosystem.config.cjs --update-env' # restart after a rebuild or env change
pm2 stop all  /  pm2 delete all                         # stop / remove
pm2 resurrect                                           # bring the saved list back after a box restart
```

- Dashboard: http://127.0.0.1:3000 (bound to localhost; the API is on 127.0.0.1:4000 and reached through the dashboard's `/api` proxy).
- There is no systemd on the box, so `pm2 startup` is unavailable. After the box itself restarts, run `pm2 resurrect`, or the `pm2 start` line above.
- To check the Telegram token and send a test message to `TELEGRAM_USER_ID`, run `cd server && ENV_FILES=/workspace/secrets/rpc.env npm run telegram:test`. Telegram only lets a bot message a user who has pressed **Start** in the bot chat first.

## Allowlist / eligibility checks (no balance needed)

Each wallet row shows three separate results:
- **Allowlisted**: yes / no / unknown / public, plus where the answer came from.
- **Contract simulation** with a fake balance.
- **Balance**: enough or not.

| Situation | How it is checked | Result |
|---|---|---|
| OpenSea drop, **active** allowlist/signed stage | Official `POST /api/v2/drops/{slug}/mint`. OpenSea checks the stage allowlist **before** balance (tested on a live signed presale: listed but unfunded wallets get `422 Insufficient balance`, unlisted wallets get `422 …not on this stage's allowlist`). | yes / no without funds |
| OpenSea drop, tx returned | The returned tx is run through `eth_call` with a `stateOverride` balance, so the signature, limits and timing are checked on-chain. Nothing is signed. | contract sim ok / revert reason |
| SeaDrop public stage, generic contracts | `eth_call` + `stateOverride` (fake balance) of the real mint tx, with SeaDrop custom errors decoded | ok / revert reason |
| SeaDrop **merkle** allowlist | `AllowListUpdated` → `allowListURI` (Etherscan v2 logs) → IPFS. If the file is plaintext, membership is computed locally and the merkle root is verified. | yes / no, or "encrypted" |
| **Upcoming** OpenSea stage (409 until it opens) | Optional **OpenSea wallet login** (Settings, off by default). Each wallet signs an off-chain SIWE message, then the official `GET /api/v2/drops/{slug}/eligibility` is called. The PAT is revoked right away and the JWT is kept in memory only. | yes / no |

Limits:
- OpenSea-hosted allowlist files are PGP-encrypted to OpenSea, and current OpenSea drops use server-signed stages instead of merkle roots, so local merkle checks rarely apply.
- Signed stages can only be checked through OpenSea: the mint API during the stage, or the wallet login before it.
- The wallet login is a real OpenSea sign-in for that wallet and accepts OpenSea's ToS. It was implemented against the official docs and SDK flow but not exercised live, because no user wallets exist yet.
- `stateOverride` works on all configured Alchemy URLs and on most public RPCs; endpoints that ignore it are skipped automatically.

## Using it

1. **Wallets**: import one key (with label and group), bulk import a `.txt` or `.csv` file (`key` or `label,key` per line), or generate N wallets. Mark one wallet as **main**. From there you can:
   - **Fund wallets**: distribute from main, with an optional top-up-to-amount mode.
   - **Sweep NFTs to vault**: send to `VAULT_ADDRESS` or an address you enter.
2. **Mint**: paste a link, slug or `0x…` address. Pick a chain, or let auto-detect find it by bytecode. You see the chain, kind (seadrop or generic), stages with price, schedule and max per wallet, and remaining supply.
   - Choose a strategy:
     - `seadrop_public`: on-chain `mintPublic` on SeaDrop `0x00005EA0…24bf5`.
     - `opensea_api`: the official `POST /api/v2/drops/{slug}/mint` builder. Needs `OPENSEA_API_KEY`. Covers allowlist and signed stages that OpenSea supports.
     - `generic`: the detected `mint(...)` function, with price read from the contract.
   - **Check wallets** shows balance vs price + gas, minted vs per-wallet limit, and allowlist status (via OpenSea when a key is set). Tick wallets and set a quantity per wallet.
   - **Simulate** runs `eth_call` + `estimateGas` per wallet and shows a cost summary with the daily-cap check. Type the confirm phrase to mint **now** or **schedule** it. Scheduled mints use the stage start or a custom time plus an offset in ms, and are pre-signed about 3 s early.
3. **Jobs**: per-wallet status, tx hash with explorer link, and minted token IDs (parsed from Transfer events).
4. **Telegram** (optional): set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID`. Send a link or address and the bot replies with a resolve summary and a dashboard deep link (`/?input=…&chain=…`). `/status` and `/jobs` work, and you get a notification when a job finishes. The bot cannot mint; confirmation always happens in the dashboard.

## Chains

| key | chainId | SeaDrop | ABI sources |
|---|---|---|---|
| ethereum | 1 | ✅ | Etherscan v2 → Blockscout → Sourcify → bytecode probe |
| base | 8453 | ✅ | same |
| polygon | 137 | ✅ | same |
| arbitrum | 42161 | ✅ | same |
| bnb | 56 | ✅ | Etherscan v2 → Sourcify → probe |
| unichain | 130 | ✅ | same |
| ink | 57073 | ✅ | Blockscout → Sourcify → probe (Ink is not in the Etherscan v2 chainlist) |
| robinhood | 4663 | ✅ | Etherscan v2 → Blockscout → Sourcify → probe |
| arc | 5042 (native USDC) | ✅ | Etherscan v2 → Blockscout → Sourcify → probe |

SeaDrop presence was verified on every chain with read-only `eth_getCode`.

**RPCs.** Each chain ships with several public RPCs. Private URLs from `RPC_<CHAIN>`, `RPC_URL_<CHAIN>` or `RPC_URLS_<CHAIN>` are tried first.
- Reads rotate to the next endpoint on errors, timeouts or rate limits, with backoff and cooldown. Reverts are never retried.
- Signed transactions are **broadcast to every endpoint**, plus send-only sequencers on Base and Robinhood.
- Each endpoint's chain ID is checked before any send.
- URLs are masked (`host/***`) in logs and the UI.

**Adding a chain.** Add an entry to `server/src/config/chains.ts` with: key, chainId, explorer, `openseaChain`, public RPCs, and optionally `etherscanV2`, `blockscoutApi`, `seadrop` and safety overrides. Then run `npm run smoke`.

## Security model

- Keys are encrypted at rest with scrypt (N = 2^17) to derive a KEK, then AES-256-GCM per key, with the address as AAD. They are stored in `DATA_DIR/db.json` (mode 0600).
- The master password unlocks the KEK for a session (`SESSION_TTL_MINUTES`). The dashboard only stores an opaque bearer token in `sessionStorage`. Locking zeroes the KEK.
- **Private keys are never returned by the API or written to logs.** Log output redacts secrets, RPC URL paths and 64-hex strings.
- The API binds to `127.0.0.1` by default. Do not expose it publicly. If you need remote access, put it behind your own VPN or SSH tunnel.
- Safety checks run before signing:
  - chain-ID check;
  - target must be the resolved contract, SeaDrop, or the OpenSea-returned address;
  - approve, setApprovalForAll, transfer and transferFrom-style selectors are blocked;
  - an OpenSea-built tx may not ask for more than the published stage price × quantity;
  - `MAX_GAS_PRICE_GWEI` fee ceiling;
  - **optional** caps (Settings, default **off = unlimited**): max price per NFT and max daily spend per chain (ledger per UTC day). `MAX_PRICE_PER_NFT` / `MAX_DAILY_SPEND` env values are only the defaults shown when you enable them.
- Only the **official** OpenSea API v2 is used (no internal GraphQL). There is no browser key injection and no tunnels.
- The scheduler runs inside the API process because the KEK only lives there. If you restart, unlock again. Jobs wait in `waiting_unlock` and fail after a 5-minute grace period.

## Known limitations

- Generic contracts: there is no allowlist, merkle-proof or signature support (those mints are flagged as unsupported). Check the auto-detected price and mint function before confirming.
- ERC-1155 SeaDrop drops and non-public stages only work through the OpenSea API path, which requires `OPENSEA_API_KEY`. That path is ERC-721 SeaDrop V1 per OpenSea's docs.
- Without `OPENSEA_API_KEY`, slug-only input cannot be resolved; paste the contract address and chain instead.
- With `ETHERSCAN_API_KEY`, Etherscan v2 serves verified ABIs on 8 of the 9 chains (all except Ink); this was checked in October 2026, including proxy-implementation lookup.
- OpenSea's mint API checks the minter's **balance before the allowlist**. For an unfunded wallet it returns `422 Insufficient balance`, so allowlist status shows as `unknown` until the wallet is funded. A real allowlist rejection shows as `not_eligible`. `409` means the stage is not active.
- Contracts without an ERC-721/1155 interface (ERC-165) are resolved but never recommended for minting, because the detected `mint` may be admin-only.
- The Etherscan v2 free tier may not cover every chain. Some Blockscout instances sit behind Cloudflare challenges; the resolver then falls through to Sourcify and a bytecode probe.
