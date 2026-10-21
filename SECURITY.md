# SkyBOT Mint — Security

## Threat model

| Threat | Control |
|---|---|
| Stolen user private keys from our DB/logs/API | **No raw keys on SkyBOT.** Wallets are Privy embedded/server wallets. Import only via Privy client `importWallet`. `/api/wallets/import` returns 403. Legacy keystore is under `server/src/_legacy/` and not compiled. |
| Malicious server-signed txs (drain / approve) | Session signer (`PRIVY_AUTH_PRIVATE_KEY`) signs only through Privy. Code denylists approve / setApprovalForAll / transfer selectors before sign. Safety module blocks those ABIs at simulate/execute. Configure Privy policies: allowlist SeaDrop + mint targets, max value, chain IDs. |
| Cross-user data access | Privy JWT (or Telegram initData → linked user) on every private route; all queries scoped by `req.user.id`. |
| Forged Telegram Mini App session | `validateInitData` HMAC-SHA256 with bot token; `auth_date` max age 24h; timing-safe compare. |
| Link-code hijack | Single-use codes, 15 min TTL, random 16/8 bytes hex; reverse codes use `pending:<tgId>` without FK confusion. |
| Credential leakage in logs/client | Redacting logger (PEM, JWT, hex64, bot tokens, secret field names). Client bundle only `NEXT_PUBLIC_PRIVY_APP_ID` + `NEXT_PUBLIC_API_URL`. |
| CSRF / hostile origins | CORS allowlist = `WEB_ORIGIN` / `PUBLIC_URL` + localhost. API uses Bearer tokens (not cookies) for Privy. Helmet on API. CSP on Next.js. |
| Rate abuse | Per-user per-route minute buckets. |
| Withdraw / transfer-out | Not exposed as first-class API today. Any future sweep/withdraw must require fresh Privy re-auth / MFA and typed confirm. |

## Custody model

1. **Create** — Privy `wallets.create` (server) or embedded wallet on login (client). SkyBOT stores `privy_wallet_id` + address only.
2. **Import** — Browser `importWallet({ privateKey })` → Privy; then `POST /api/wallets/sync` with address ids. Raw key never hits our backend.
3. **Export** — Only Privy’s export UI. No SkyBOT export endpoint.
4. **Scheduled mint** — Privy session signer signs; we broadcast signed raw tx via multi-RPC. No local key decrypt.

## Production checklist

- [ ] `ALLOW_SERVER_KEY_IMPORT` unset / not `1`
- [ ] `NODE_ENV=production`
- [ ] `PRIVY_APP_SECRET`, bot token, `DATABASE_URL`, auth PEM only in host secrets
- [ ] Privy Dashboard: allowed origins = Vercel URL + `https://web.telegram.org`
- [ ] Privy Telegram login: bot token + handle; enable seamless Mini App auth
- [ ] Privy wallet policies for session signer (targets, chains, max value, deny approvals)
- [ ] BotFather `/setdomain` = Vercel host; menu button URL = `PUBLIC_URL`
- [ ] `TELEGRAM_WEBHOOK_SECRET` set when using `PUBLIC_API_URL`
- [ ] npm lockfile committed; `npm audit` clean of high/critical

## Reporting

If you find a vulnerability in SkyBOT Mint, email the operator privately — do not open a public issue with exploit details.
