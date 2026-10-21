# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
