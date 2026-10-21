# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **NFTs** page (dashboard and Mini App): every NFT held by your wallets on all supported chains, with image, collection, token ID, chain, standard and ERC-1155 quantity. Filter by wallet, chain or collection, group by wallet or collection, select one by one or all, and send to one address. ERC-721 and ERC-1155 `safeTransferFrom`, signed in the browser with Privy and verified by the server before broadcast. Ownership and gas are re-checked right before sending; wallets without gas are skipped with a clear reason.
- Holdings come from an NFT indexer (Alchemy NFT API, OpenSea as fallback and for Ink), are cached in the database, and are only re-scanned for new wallets, on manual Refresh (60 s cooldown) or updated in place after a send.

### Changed

- Fewer RPC calls: Multicall3 batching for native balances, SeaDrop mint counts and NFT ownership; 30 s balance cache shared by concurrent requests; 12 s fee cache for estimates; 60 s cache for repeated link resolution (`/check`, Resolve); batched transaction status with back-off; Jobs and Settings poll only while visible.
- Wallet deletion is also blocked when the last holdings scan shows NFTs in the wallet.

- Unified login through Privy: email, Google and Telegram on both the website and the Telegram Mini App resolve to one SkyBOT account. Telegram login is now offered on the web.
- The Mini App prefers Privy seamless Telegram login. The verified `initData` session remains as a fallback with a **Connect with Privy** action, so wallet import works for Telegram users.
- Settings shows **Sign-In Methods** (link Telegram, email or Google through Privy) instead of link codes. The bot no longer advertises `/link` or `/unlink`.

### Fixed

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
