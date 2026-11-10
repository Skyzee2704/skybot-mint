# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **$SKYBOT contract address** on the public landing page: the token contract, with a copy button and a link to its Volta.family token page. The copy button works in the browser and the Telegram Mini App.

- **Remove wallets that still hold funds or NFTs**: the remove dialog lists balances per chain and cached NFTs, offers Withdraw first / Send NFTs first and (for Privy-created wallets) Export Private Key, and requires ticking an acknowledgement and typing the wallet name. Removal archives the wallet in Privy, the strongest removal Privy supports (there is no wallet delete endpoint, and embedded or imported wallets can't be unlinked from a Privy user). Removing the Main wallet asks which wallet becomes Main (default: the oldest remaining).
- **Fund Wallets** (Wallets page, dashboard and Mini App): split native coin from your Main wallet evenly across your other wallets on any supported chain. Send to all or pick wallets, enter a total or use Max (Main balance minus the exact network fees of every transfer); the wei rounding remainder stays in Main. Transfers are signed one by one in your browser (60 s timeout, Stop, Retry Unsent) and verified by SkyBOT before broadcasting. Not available through Telegram commands.
- **Kalos drops on Elysium.** `kalos.fun` links, slugs, and matching contracts resolve to Kalos stages (HYPE prices, UTC times). Eligibility uses the Kalos API plus the shared on-chain mint counter. Allowlist mints send `mintAllowList` with the proof unchanged; the public stage uses `mintPublic`. A contract listed on both OpenSea and Kalos follows the SeaDrop the NFT actually allows. A balance below price plus gas is a warning only: the wallet stays eligible and the mint is still attempted.

### Fixed

- Native balances and costs use the chain's own symbol (HYPE on Elysium, USDC on Arc, POL on Polygon, BNB on BNB Chain, ETH elsewhere). Amounts from different chains are not added under one symbol. An ERC-20 mint price keeps that token's symbol.

### Removed

- Wallet groups. The Group column, the group fields on Create and Import, and the `/api/groups` endpoints are gone. Existing group data is left untouched in the database.

- **NFTs** page (dashboard and Mini App): every NFT held by your wallets on all supported chains, with image, collection, token ID, chain, standard and ERC-1155 quantity. Filter by wallet, chain or collection, group by wallet or collection, select one by one or all, and send to one address. ERC-721 and ERC-1155 `safeTransferFrom`, signed in the browser with Privy and verified by the server before broadcast. Ownership and gas are re-checked right before sending; wallets without gas are skipped with a clear reason.
- Holdings come from an NFT indexer (Alchemy NFT API, OpenSea as fallback and for Ink), are cached in the database, and are only re-scanned for new wallets, on manual Refresh (60 s cooldown) or updated in place after a send.

### Changed

- Scheduled mint execution after T0: `/api/jobs/run` runs in `iad1` (the rest of the app stays in `sin1`). The OpenSea mint request starts 150ms before the stage and retries a 409 every 75ms (429 backs off). TLS sockets to OpenSea, Privy, and the broadcast RPCs are warmed about 8s beforehand. The post-T0 path does not wait on the database. Each wallet logs its first-attempt offset, attempt count, and build/sign/broadcast times.
- Scheduled mints resolve the drop and fees when the function wakes, and read nonces only in the last few seconds. Public, generic, and a readable merkle allowlist are signed before the start using the simulation gas plus 30%, and broadcast at the start second. Signed GTD/FCFS still use the OpenSea mint API, with a 1.5s timeout and the gas hint when one was saved.
- The landing page no longer shows the $SKYBOT contract address or the Volta.family link.
- Elysium Mainnet (chain id 99901, native HYPE). SeaDrop and Multicall3 are deployed. OpenSea chain slug is `elysium`. Etherscan v2 does not list the chain. Optional private RPC: `RPC_ELYSIUM`.

- Fewer RPC calls: Multicall3 batching for native balances, SeaDrop mint counts and NFT ownership; 30 s balance cache shared by concurrent requests; 12 s fee cache for estimates; 60 s cache for repeated link resolution (`/check`, Resolve); batched transaction status with back-off; Jobs and Settings poll only while visible.
- Wallet deletion is also blocked when the last holdings scan shows NFTs in the wallet.

- Unified login through Privy: email, Google and Telegram on both the website and the Telegram Mini App resolve to one SkyBOT account. Telegram login is now offered on the web.
- The Mini App prefers Privy seamless Telegram login. The verified `initData` session remains as a fallback with a **Connect with Privy** action, so wallet import works for Telegram users.
- Settings shows **Sign-In Methods** (link Telegram, email or Google through Privy) instead of link codes. The bot no longer advertises `/link` or `/unlink`.
- Mint page: the stage is chosen only on the eligibility cards (including Public, and Now when a drop has no stages). Timing keeps gas, the start-time offset, and when the mint runs. The wallet table lists only wallets eligible for that stage, and the only quick action above it is Clear. The Check all / Select wallets toggle reads as a selection, not a second primary button.

### Fixed

- Mint stage selection (dashboard and Mini App): the wallet table and the Timing picker follow the stage you choose. They no longer stick to the first stage (or Public only) when your wallets are eligible for a later allowlist stage. The default is the earliest stage some wallet can mint. Scheduling that stage still fires at its start and uses its per-wallet limit.
- Parallel first-login requests no longer fail with `privy auth failed` (idempotent user creation).
- Privy identity tokens are now actually sent to the server, so email and Telegram details are picked up.

## [1.0.0] - 2026-10-21

### Added

- Multi-user mint desk: OpenSea drop and SeaDrop resolver, generic contract mints, wallet eligibility (allowlist checks without funding), simulation, and multi-RPC broadcast.
- Privy authentication (email, Google, Telegram) and Privy-custodied wallets: embedded and server wallets, client-side import and export, and server signing through authorization keys.
- Telegram bot (`/start`, `/link`, `/unlink`, `/mint`, `/wallets`, `/jobs`, `/help`) with two-way account linking and job notifications.
- Telegram Mini App: the full dashboard inside Telegram with seamless login, Telegram-first accounts, MainButton confirm, BackButton, haptics, and theme colors.
- Scheduled mints with Upstash QStash (early fire, in-function precise wait, idempotent job claiming) and a housekeeping cron.
- Single-project Vercel deployment: Next.js route handlers, Neon Postgres, optional Upstash Redis rate limits, and Telegram webhook mode.
- Security hardening: per-user scoping, initData HMAC verification, short-lived httpOnly sessions with a CSRF header, QStash signature verification, strict CORS and CSP, Zod validation, and log redaction.
- Wallet groups, optional spend caps, admin user list, and chain health check.
- Supported chains: Ethereum, Base, Polygon, Arbitrum One, BNB Smart Chain, Unichain, Ink, Robinhood Chain, and Arc.
- Project documentation (README, DEPLOY, SECURITY, CONTRIBUTING, Code of Conduct), GitHub Actions CI, ESLint, and Prettier.
- Licensed under AGPL-3.0-only, with a "Source" link in the web footer.

[Unreleased]: https://github.com/Skyzee2704/skybot-mint/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Skyzee2704/skybot-mint/releases/tag/v1.0.0
