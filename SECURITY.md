# Security Policy

## Reporting a Vulnerability

Please **do not open a public issue** for security problems. Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on this repository, or contact the maintainers privately. Include reproduction steps and the affected version. We aim to acknowledge reports within 72 hours.

## Threat Model and Controls

| Threat | Control |
|---|---|
| Theft of user private keys from our database, logs, or API | **No raw keys on SkyBOT.** Wallets are Privy embedded or server wallets. Import uses Privy's client-side `importWallet`, so keys are encrypted to Privy in the browser. `POST /api/wallets/import` returns 403. The legacy keystore lives in `server/src/_legacy/` and is not compiled. |
| Key export by an attacker | Export is only possible through Privy's export UI in the user's own authenticated session. There is no SkyBOT export endpoint. |
| Malicious server-signed transactions (drain, approve) | Server signing uses only Privy authorization keys (`PRIVY_AUTH_PRIVATE_KEY` plus a key quorum). The code denies `approve`, `setApprovalForAll`, and `transfer*` selectors before signing, and the safety module blocks them at simulate and execute time. Configure Privy policies as a second layer: target allowlist, max value, and chain IDs. |
| Cross-user data access | Every private route requires a Privy JWT, a SkyBOT session cookie, or verified Telegram initData. Every query is scoped by `user.id`. Cross-user access is covered by tests. |
| Forged Telegram Mini App login | `initData` is verified with HMAC-SHA256 using the bot token and a timing-safe compare. `auth_date` max age is 1 h for session creation and 24 h for the header fallback. Forgery is covered by tests. |
| Session theft or CSRF (Telegram-first accounts) | Sessions are HMAC-signed, last 1 h, and use `HttpOnly; Secure; SameSite=None; Path=/api` cookies. State-changing requests also require the `X-SkyBOT-CSRF` header, which cross-site forms cannot set and which CORS restricts. |
| Link-code hijack | Codes are random, single-use, and expire after 15 minutes. Expired codes are purged by housekeeping. |
| Forged scheduler or cron calls | `/api/jobs/run` and `/api/cron/housekeeping` verify the QStash `Upstash-Signature` (current and next keys, URL-bound). Jobs are claimed atomically, so duplicate deliveries are no-ops. |
| Forged Telegram updates | `/api/telegram/webhook` requires `X-Telegram-Bot-Api-Secret-Token` to equal `TELEGRAM_WEBHOOK_SECRET`. Without the secret, the route answers 404. |
| Credential leakage (logs, client bundle) | The logger redacts PEM blocks, JWTs, 64-hex keys, bot tokens, and known secret field names. Only `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SOURCE_URL`, and the bot username are inlined into the client. |
| Hostile origins and injection | Strict CORS (`PUBLIC_URL`/`WEB_ORIGIN`), Helmet, CSP, HSTS, `nosniff`, `no-referrer`, and `frame-ancestors` limited to Telegram. All inputs are validated with Zod. |
| Abuse and brute force | Per-user, per-route rate limits (Upstash Redis sliding window, with an in-memory fallback). |
| Withdraw and transfer-out | Not exposed as an API. Any future withdraw or sweep must require fresh Privy re-authentication (MFA or passkey) and typed confirmation. |
| Supply chain | Committed lockfile, `npm ci` in CI, install scripts allowlisted, and `npm audit` reviewed for high and critical issues. |

## Custody Model

1. **Create**: Privy creates the wallet (embedded on login, or server-side). SkyBOT stores only the Privy wallet ID and address.
2. **Import**: the browser calls Privy `importWallet`, then `POST /api/wallets/sync` with wallet IDs. The raw key never reaches SkyBOT.
3. **Export**: only through Privy's export modal.
4. **Scheduled mint**: SkyBOT's key quorum signs through the Privy API, and SkyBOT broadcasts the signed transaction to multiple RPCs. No key material is ever decrypted on SkyBOT.

## Production Checklist

- [ ] `NODE_ENV=production` (Vercel default) and `ALLOW_SERVER_KEY_IMPORT` unset
- [ ] Secrets set only in Vercel environment variables (`PRIVY_APP_SECRET`, `PRIVY_AUTH_PRIVATE_KEY`, `SESSION_SECRET`, `TELEGRAM_*`, `QSTASH_*`, `DATABASE_URL`)
- [ ] `SESSION_SECRET` set (32+ random bytes) and shared by all instances
- [ ] Privy allowed origins: production URL and `https://web.telegram.org`
- [ ] Privy Telegram login enabled with OAuth credentials (Client ID and Secret from @BotFather) plus the bot token and name for Mini App seamless login. `https://auth.privy.io/api/v1/oauth/callback` is in the bot's Allowed URLs, and BotFather `/setdomain` points to the production host
- [ ] Privy policies on the authorization key: target allowlist, chain IDs, max value, deny approvals and transfers
- [ ] `TELEGRAM_WEBHOOK_SECRET` set and `npm run telegram:setup` run after each URL change
- [ ] QStash signing keys set, and `PUBLIC_URL` exactly matches the deployed URL
- [ ] Upstash Redis configured for shared rate limits
- [ ] `npm audit --omit=dev` reviewed for high and critical issues

## Supported Versions

Only the latest release on `main` receives security fixes.
