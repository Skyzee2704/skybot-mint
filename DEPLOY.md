# Deploying SkyBOT Mint

SkyBOT Mint runs as a **single Vercel project**. The Next.js app serves both the UI and the API. Supporting services:

| Service | Purpose | Plan |
|---|---|---|
| [Vercel](https://vercel.com) | Hosting (Next.js, Node.js functions) | Hobby or Pro |
| [Neon](https://neon.tech) | Postgres database | Free tier is fine |
| [Upstash QStash](https://upstash.com/docs/qstash) | Scheduled mints and the housekeeping cron | Free tier is fine |
| [Upstash Redis](https://upstash.com/docs/redis) | Shared rate limits (optional, recommended) | Free tier is fine |
| [Privy](https://dashboard.privy.io) | Authentication and wallet custody | — |
| Telegram [@BotFather](https://t.me/BotFather) | Bot and Mini App | — |

Plan for about 30 minutes for the first deployment.

---

## 1. Push to GitHub

```bash
git remote add origin https://github.com/skyzee2706/skybot-mint.git
git push -u origin main
```

`.gitignore` already excludes `.env*` (except `.env.example`), `data/`, databases, keys, and build output. Never commit real secrets.

## 2. Create the Database (Neon)

1. Create a Neon project and a database, for example `skybot`.
2. Copy the **pooled** connection string (`postgresql://…-pooler…/skybot?sslmode=require`). This is your `DATABASE_URL`.
3. Migrations run automatically on the first request. To run them ahead of time:
   ```bash
   DATABASE_URL="postgresql://…" npm run migrate
   ```

## 3. Create Upstash QStash (and Redis)

1. In the Upstash console, go to **QStash** and copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`. If your QStash region shows a different endpoint, also set `QSTASH_URL`.
2. Optional but recommended: create a **Redis** database and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without Redis, rate limits are per function instance only.

## 4. Import into Vercel

1. **Add New → Project**, then import the GitHub repository.
2. **Root Directory: `web`**. Leave "Include files outside the root directory" enabled, which is the default. The app depends on the `server/` workspace package.
3. Framework preset: **Next.js**. Install and build commands come from `web/vercel.json` (`cd .. && npm ci`, then `npm run build`).
4. Keep **Fluid compute** enabled (the default).
5. Add the environment variables from step 5, then click **Deploy**.
6. After the first deploy, note your production URL, for example `https://skybot-mint.vercel.app`. Set `PUBLIC_URL` to it and **redeploy**.

### Function durations

| Route | `maxDuration` | Why |
|---|---|---|
| `/api/jobs/run` | 300 s | Pre-signs, waits until stage start, broadcasts, and tracks receipts |
| `/api/cron/housekeeping` | 60 s | Finishes receipts, expires stuck or missed jobs, purges link codes |
| `/api/*` | 60 s | Regular API |

With Fluid compute, both **Hobby and Pro allow up to 300 s**, and Pro can go up to 800 s. Keep `JOB_MAX_DURATION_SEC` equal to the `/api/jobs/run` value.

## 5. Environment Variables

Set these in **Vercel → Project → Settings → Environment Variables** for Production, and for Preview if you use it. See [`.env.example`](.env.example) for the full list.

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy Dashboard → App settings → App ID |
| `PRIVY_APP_SECRET` | Privy Dashboard → App settings → App secret |
| `PRIVY_AUTH_PRIVATE_KEY` | Privy Dashboard → Wallet infrastructure → Authorization keys → New key (shown once) |
| `PRIVY_AUTH_KEY_QUORUM_ID` | Privy Dashboard → the key quorum containing that authorization key |
| `PUBLIC_URL` | Your Vercel production URL (`https://…`, no trailing slash) |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DATABASE_URL` | Neon pooled connection string |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Upstash Console → QStash |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash Console → Redis → REST API (optional) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/mybots` → API Token |
| `TELEGRAM_BOT_USERNAME` | Your bot's username without `@`, for example `MyTradeSkyBOT` |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 24` (letters, digits, `_` and `-` only) |
| `TELEGRAM_USER_ID`, `ADMIN_TELEGRAM_IDS` | Your numeric Telegram ID (for example from @userinfobot) |
| `ADMIN_EMAILS` | Emails that receive the admin role |
| `OPENSEA_API_KEY` | OpenSea developer portal |
| `ETHERSCAN_API_KEY` | etherscan.io → API Keys (V2 works across chains) |
| `RPC_ETHEREUM`, `RPC_BASE`, … | Your RPC provider (Alchemy, QuickNode, …). Public RPCs are used as fallbacks |
| `NEXT_PUBLIC_SOURCE_URL` | Your public GitHub repository URL (AGPL "Source" link) |
| `JOB_LEAD_MS` | Optional, default `20000` |
| `MAX_PRICE_PER_NFT`, `MAX_DAILY_SPEND`, `MAX_GAS_PRICE_GWEI` | Optional global safety limits |

> `NEXT_PUBLIC_*` values are inlined into the browser bundle when you build, so redeploy after you change them. Every other value stays on the server.

## 6. Post-Deploy Setup (Telegram Webhook and QStash Cron)

Run this once per production URL. It sets the Telegram webhook (with `secret_token`), commands, description, and the **Open Dashboard** menu button (Mini App), and it creates the QStash housekeeping schedule (every 2 minutes).

**Option A: admin API.** Sign in to the dashboard with an admin account, then call `POST /api/admin/telegram/setup`. It requires an admin session.

**Option B: script, from your machine:**

```bash
PUBLIC_URL=https://skybot-mint.vercel.app \
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
QSTASH_TOKEN=… \
npm run telegram:setup
```

To verify, open `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`. The URL should be `…/api/telegram/webhook` with no `last_error_message`. In the Upstash console, the schedule `skybot-housekeeping` should be listed.

## 7. Configure Privy

In the [Privy Dashboard](https://dashboard.privy.io), for your app:

1. **Login methods**
   - Enable **Email** and **Google**.
   - Enable **Telegram**: enter the **bot token** and **bot handle** (`@MyTradeSkyBOT`). This enables Telegram login and **seamless login inside the Telegram Mini App**.
2. **Domains / Allowed origins**
   - `https://<your-app>.vercel.app` (and your custom domain, if any)
   - `https://web.telegram.org` (Telegram Web clients)
   - `http://localhost:3000` (local development; remove it in production if you prefer)
3. **Embedded wallets**: set **Create on login** to *Users without wallets* (EVM).
4. **Authorization keys**: create an authorization key and a **key quorum**. Put the private key in `PRIVY_AUTH_PRIVATE_KEY` and the quorum ID in `PRIVY_AUTH_KEY_QUORUM_ID`. SkyBOT adds this quorum as a signer so scheduled mints can be signed server-side.
5. **Policies (strongly recommended)**: attach a policy to the signer that allowlists contract targets (SeaDrop and the mint contracts you use), limits `value` per transaction, restricts chain IDs, and denies `approve`, `setApprovalForAll`, and `transfer`. See [SECURITY.md](SECURITY.md).

## 8. Configure BotFather

In [@BotFather](https://t.me/BotFather):

1. `/setdomain`: select your bot and enter your Vercel host, for example `skybot-mint.vercel.app`. Telegram Login requires this.
2. `/setuserpic`: upload `assets/logo-512.png`.
3. Optional: `/setmenubutton` sets the menu button manually to `PUBLIC_URL` with the text **Open Dashboard**. Step 6 already does this through the API.
4. Optional: `/newapp` registers a named Mini App (t.me/<bot>/<app>) that points to `PUBLIC_URL`.

## 9. Smoke Test

1. Open `https://<your-app>/api/health`. It should report `"db":"postgres"`, `"scheduler":"qstash"`, `"webhook":true`, and `"miniApp":true`.
2. Sign in on the web with email or Google. Wallets are created on first login.
3. In Telegram, send `/start` to the bot and tap **Open Dashboard**. You should be logged in automatically.
4. Link accounts if you signed up on both. See "Account Linking" below.
5. Schedule a small test mint a few minutes ahead and watch **Jobs**.

## Account Linking (Telegram ↔ Web)

- **Web → Telegram:** go to **Settings → Connect Telegram → Generate Deep Link** and open the link. The bot confirms, and the web page updates automatically.
- **Telegram → Web:** send `/link` to the bot, then paste the code into **Settings → Connect Telegram**.
- **Telegram-first accounts:** opening the Mini App without a linked account creates a SkyBOT account automatically. You can attach email or Google later in **Settings → Link Email / Google**.
- **Unlink:** use `/unlink` in Telegram or **Settings → Unlink**.

Link codes are single-use and expire after 15 minutes.

## Timing Expectations

QStash delivers the message about `JOB_LEAD_MS` (default 20 s) before the stage starts. The function then pre-signs the transactions, waits in-process until the exact start time, and broadcasts to every RPC in parallel. Expect broadcasts within roughly **50–300 ms of stage start**, depending on the region and RPC latency. Deploy your Vercel functions in a region close to your RPC providers (Project → Settings → Functions → Region). If QStash delivers late, the job still fires as soon as it arrives. Jobs that miss their window are marked as missed by housekeeping.

## Local Development

See [README → Quick Start](README.md#quick-start-local-development). Locally, the bot uses **long polling** and the scheduler runs in-process. Do not set `TELEGRAM_WEBHOOK_SECRET` locally if the production webhook is active for the same bot, because Telegram delivers updates either by webhook or by polling, never both.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 invalid signature` on `/api/jobs/run` | `PUBLIC_URL` must exactly match the deployed URL, and the signing keys must match QStash |
| Mini App opens but asks to sign in | Enable Telegram login in Privy, run BotFather `/setdomain`, and check `PUBLIC_URL` |
| Webhook `last_error_message: 401` | `TELEGRAM_WEBHOOK_SECRET` changed. Rerun step 6 |
| "Scheduler unavailable" when scheduling | Check `QSTASH_TOKEN` (and `QSTASH_URL` for your region) |
| Function timeout on scheduled mints | Reduce `JOB_LEAD_MS` or raise `maxDuration` (Pro) |
