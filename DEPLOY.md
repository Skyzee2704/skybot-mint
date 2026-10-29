# Deploying SkyBOT Mint

SkyBOT Mint runs as a **single Vercel project**. The Next.js app serves both the UI and the API. Supporting services:

| Service                                           | Purpose                                    | Plan              |
| ------------------------------------------------- | ------------------------------------------ | ----------------- |
| [Vercel](https://vercel.com)                      | Hosting (Next.js, Node.js functions)       | Hobby or Pro      |
| [Neon](https://neon.tech)                         | Postgres database                          | Free tier is fine |
| [Upstash QStash](https://upstash.com/docs/qstash) | Scheduled mints and the housekeeping cron  | Free tier is fine |
| [Upstash Redis](https://upstash.com/docs/redis)   | Shared rate limits (optional, recommended) | Free tier is fine |
| [Privy](https://dashboard.privy.io)               | Authentication and wallet custody          | —                 |
| Telegram [@BotFather](https://t.me/BotFather)     | Bot and Mini App                           | —                 |

Plan for about 30 minutes for the first deployment.

---

## 1. Push to GitHub

```bash
git remote add origin https://github.com/Skyzee2704/skybot-mint.git
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

| Route                    | `maxDuration` | Why                                                                 |
| ------------------------ | ------------- | ------------------------------------------------------------------- |
| `/api/jobs/run`          | 300 s         | Pre-signs, waits until stage start, broadcasts, and tracks receipts |
| `/api/cron/housekeeping` | 60 s          | Finishes receipts, expires stuck or missed jobs, purges link codes  |
| `/api/*`                 | 60 s          | Regular API                                                         |

With Fluid compute, both **Hobby and Pro allow up to 300 s**, and Pro can go up to 800 s. Keep `JOB_MAX_DURATION_SEC` equal to the `/api/jobs/run` value.

## 5. Environment Variables

Set these in **Vercel → Project → Settings → Environment Variables** for Production, and for Preview if you use it. See [`.env.example`](.env.example) for the full list.

| Variable                                                                | Where to get it                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PRIVY_APP_ID`                                              | Privy Dashboard → App settings → App ID                                             |
| `PRIVY_APP_SECRET`                                                      | Privy Dashboard → App settings → App secret                                         |
| `PRIVY_AUTH_PRIVATE_KEY`                                                | Privy Dashboard → Wallet infrastructure → Authorization keys → New key (shown once) |
| `PRIVY_AUTH_KEY_QUORUM_ID`                                              | Privy Dashboard → the key quorum containing that authorization key                  |
| `PUBLIC_URL`                                                            | Your Vercel production URL (`https://…`, no trailing slash)                         |
| `SESSION_SECRET`                                                        | `openssl rand -hex 32`                                                              |
| `DATABASE_URL`                                                          | Neon pooled connection string                                                       |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Upstash Console → QStash                                                            |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                    | Upstash Console → Redis → REST API (optional)                                       |
| `TELEGRAM_BOT_TOKEN`                                                    | @BotFather → `/mybots` → API Token                                                  |
| `TELEGRAM_BOT_USERNAME`                                                 | Your bot's username without `@`, for example `SkymintsBOT`                        |
| `TELEGRAM_WEBHOOK_SECRET`                                               | `openssl rand -hex 24` (letters, digits, `_` and `-` only)                          |
| `TELEGRAM_USER_ID`, `ADMIN_TELEGRAM_IDS`                                | Your numeric Telegram ID (for example from @userinfobot)                            |
| `ADMIN_EMAILS`                                                          | Emails that receive the admin role                                                  |
| `OPENSEA_API_KEY`                                                       | OpenSea developer portal                                                            |
| `ETHERSCAN_API_KEY`                                                     | etherscan.io → API Keys (V2 works across chains)                                    |
| `RPC_ETHEREUM`, `RPC_BASE`, …                                           | Your RPC provider (Alchemy, QuickNode, …). Public RPCs are used as fallbacks        |
| `NEXT_PUBLIC_SOURCE_URL`                                                | Your public GitHub repository URL (AGPL "Source" link)                              |
| `JOB_LEAD_MS`                                                           | Optional, default `20000`                                                           |
| `MAX_PRICE_PER_NFT`, `MAX_DAILY_SPEND`, `MAX_GAS_PRICE_GWEI`            | Optional global safety limits                                                       |

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
   - Enable **Email** and **Google** (Socials tab). Google works with Privy's default credentials; no Google Cloud setup is needed.
   - Do **not** enable wallet login. SkyBOT accounts are email, Google, or Telegram only.
   - Enable **Telegram** and fill in both parts of its settings:
     - **OAuth credentials (Recommended)**: the **Client ID** and **Client secret** from @BotFather (see _Telegram OAuth credentials_ below). This powers Telegram login on the website.
     - **Bot token and name**: the bot token and the bot handle (`SkymintsBOT`). Mini App sessions are signed by Telegram with the bot token, so keep these filled for seamless login inside Telegram.
     - Tick **Enable login directly from the Telegram app, such as with Telegram Mini Apps** (seamless login).
   - **Identity tokens** (recommended): enable _Return user data in an identity token_. SkyBOT reads linked accounts (email, Google, Telegram) from it without an extra Privy API call. Without it, SkyBOT falls back to one Privy API lookup the first time a login is seen.
2. **Domains / Allowed origins**
   - `https://<your-app>.vercel.app` (and your custom domain, if any)
   - `https://web.telegram.org` and `http://web.telegram.org` (Telegram Web clients)
   - `http://localhost:3000` (local development; remove it in production if you prefer)
3. **Embedded wallets**: set **Create on login** to _Users without wallets_ (EVM).
4. **Authorization keys**: create an authorization key and a **key quorum**. Put the private key in `PRIVY_AUTH_PRIVATE_KEY` and the quorum ID in `PRIVY_AUTH_KEY_QUORUM_ID`. SkyBOT adds this quorum as a signer so scheduled mints can be signed server-side.
5. **OpenSea sign-in signer (optional, for Telegram `/check`)** — a second, sign-in-only signer:
   1. Generate a P-256 key locally: `openssl ecparam -name prime256v1 -genkey -noout -out siwe.pem && openssl ec -in siwe.pem -pubout -out siwe.pub.pem` ([Privy: create an authorization key](https://docs.privy.io/wallets/using-wallets/signers/quickstart)).
   2. Privy Dashboard → **Authorization keys** → **New key** → **Register key quorum instead**: paste the public key, threshold **1**, name it "SkyBOT OpenSea sign-in". Copy the quorum id → `PRIVY_SIWE_KEY_QUORUM_ID`.
   3. Privy Dashboard → **Policies** → create an **ethereum** policy with exactly one rule: method `personal_sign`, action **ALLOW**, condition `message.content` **starts_with** `opensea.io wants you to sign in with your Ethereum account:\n{{wallet.address}}`. No other rules (Privy denies every method without an ALLOW rule). Copy the policy id → `PRIVY_SIWE_POLICY_ID` ([policies](https://docs.privy.io/controls/policies/overview), [message rules](https://docs.privy.io/controls/policies/example-policies/ethereum), [`{{wallet.address}}`](https://docs.privy.io/controls/policies/template-variables)).
   4. Convert the private key to the base64 PKCS#8 form the Privy Node SDK expects — `openssl pkcs8 -topk8 -nocrypt -in siwe.pem -outform DER | base64 -w0` — and put that value in `PRIVY_SIWE_AUTH_PRIVATE_KEY` on Vercel (keep `siwe.pem` offline; Privy can't recover it), then redeploy. SkyBOT then attaches the signer with that policy automatically:
      - **at creation** for server-generated wallets (`additional_signers` on `wallets().create`);
      - **by the member's own session** for client-created and imported wallets: `/api/me` reports which wallets already carry the signer (checked against Privy), the app adds it to the rest with `useSigners().addSigners` ([docs](https://docs.privy.io/wallets/using-wallets/signers/add-signers)) and then calls `/api/wallets/siwe-signer/verify`, which re-reads the wallets from Privy and records them in `siwe_signers`. (A server-side update with `authorization_context.user_jwts` is not used: Privy's `/v1/wallets/authenticate` answers 400 "Invalid JWT token provided" for this app's Privy access tokens, even fresh, locally verified ones.)
      - **housekeeping** (every 2 min) fixes legacy wallet ids and re-checks wallets that still lack the signer (each at most every 6 h).

      Limits: wallets created by Privy's client SDKs are **user-owned**, so changing their signers needs the owner's authorization ([self-custodial user wallets](https://docs.privy.io/controls/authorization-keys/owners/configuration/user)). With the member offline, only wallets owned by a 1-of-k key quorum that includes an app key can be updated ([server updates](https://docs.privy.io/controls/authorization-keys/owners/configuration/user/server-updates)). SkyBOT deliberately doesn't migrate ownership (that would let the server rewrite signers on members' wallets). A wallet without the signer shows "not verified yet" in `/check` until the member next opens SkyBOT signed in with Privy (Mini App sessions without Privy can't add it); live stages are still checked through the OpenSea mint API, which needs no signature.
6. **Policies (strongly recommended)**: attach a policy to the signer that allowlists contract targets (SeaDrop and the mint contracts you use), limits `value` per transaction, restricts chain IDs, and denies `approve`, `setApprovalForAll`, and `transfer`. See [SECURITY.md](SECURITY.md).

## 8. Configure BotFather

In [@BotFather](https://t.me/BotFather):

1. **Telegram OAuth credentials** (for Privy's _OAuth credentials_ fields). Telegram documents this in [Log In With Telegram → Registering your Allowed URLs](https://core.telegram.org/bots/telegram-login#registering-your-allowed-urls):
   1. Open the @BotFather **Mini App** (the _Open_ button in the BotFather chat), select your bot, then open **Login Widget** (some clients label it _Bot Settings → Web Login_).
   2. Add these **Allowed URLs**:
      - `https://auth.privy.io/api/v1/oauth/callback` (Privy's OAuth callback, required)
      - `https://<your-app>.vercel.app` (the website origin where the login button appears)
   3. Copy the **Client ID** and **Client Secret** shown in the same section and paste them into Privy → Login methods → Telegram → _OAuth credentials_. The Client Secret is **not** the bot token.
2. `/setdomain`: select your bot and enter your Vercel host, for example `skybot-mint.vercel.app`. This is still needed by the legacy Login Widget flow that Privy uses with _Bot token and name_.
3. `/setuserpic`: upload `assets/logo-512.png`. Telegram shows the bot's name and picture on the login consent screen.
4. Optional: `/setmenubutton` sets the menu button manually to `PUBLIC_URL` with the text **Open Dashboard**. Step 6 already does this through the API.
5. Optional: `/newapp` registers a named Mini App (t.me/<bot>/<app>) that points to `PUBLIC_URL`.

## 9. Smoke Test

1. Open `https://<your-app>/api/health`. It should report `"db":"postgres"`, `"scheduler":"qstash"`, `"webhook":true`, and `"miniApp":true`.
2. Sign in on the web with email or Google. Wallets are created on first login.
3. In Telegram, send `/start` to the bot and tap **Open Dashboard**. You should be logged in automatically through Privy.
4. On the web, sign out and sign in again with **Telegram**. You should land in the same account (same wallets).
5. Schedule a small test mint a few minutes ahead and watch **Jobs**.

## One Account Across Web and Telegram

Every login goes through Privy, so email, Google and Telegram are linked accounts of one Privy user and therefore one SkyBOT account. There are no link codes.

- **Mini App:** Privy signs the user in with Telegram automatically. If seamless login is unavailable, SkyBOT falls back to a short-lived session verified from Telegram `initData` and shows **Connect with Privy**, which is required for wallet import and generation.
- **Web:** choose **Telegram**, **Email** or **Google** on the sign-in screen. Telegram on the web reaches the same account as the Mini App.
- **Linking more logins:** **Settings → Sign-In Methods** links Telegram, email or Google to the current Privy user.
- **Existing Telegram-first accounts** (created before Privy Telegram login was enabled) are matched by Telegram user ID on the first Privy Telegram login and keep their wallets.
- **Conflicts:** if a Telegram account already belongs to a different SkyBOT account that owns wallets, SkyBOT refuses to merge and returns `409 ACCOUNT_CONFLICT`. Sign in with the original login instead, or ask an admin.

Legacy `/start link_<code>` deep links and the `/api/telegram/link-code` endpoints still work for backward compatibility but are no longer shown in the UI.

## Timing Expectations

QStash delivers the message about `JOB_LEAD_MS` (default 20 s) before the stage starts. The function then pre-signs the transactions, waits in-process until the exact start time, and broadcasts to every RPC in parallel. Expect broadcasts within roughly **50–300 ms of stage start**, depending on the region and RPC latency. Deploy your Vercel functions in a region close to your RPC providers (Project → Settings → Functions → Region). If QStash delivers late, the job still fires as soon as it arrives. Jobs that miss their window are marked as missed by housekeeping.

## Local Development

See [README → Quick Start](README.md#quick-start-local-development). Locally, the bot uses **long polling** and the scheduler runs in-process. Do not set `TELEGRAM_WEBHOOK_SECRET` locally if the production webhook is active for the same bot, because Telegram delivers updates either by webhook or by polling, never both.

## Troubleshooting

| Symptom                                               | Fix                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 invalid signature` on `/api/jobs/run`            | `PUBLIC_URL` must exactly match the deployed URL, and the signing keys must match QStash                                                                                           |
| Mini App opens but shows **Connect with Privy**       | Seamless login is off or misconfigured: tick _Enable login directly from the Telegram app_, fill in the bot token and name in Privy, and add `web.telegram.org` to allowed domains |
| Telegram login on the web fails with a redirect error | Add `https://auth.privy.io/api/v1/oauth/callback` and your site origin to the bot's Allowed URLs in @BotFather, and check the Client ID and Secret in Privy                        |
| `409 ACCOUNT_CONFLICT` after login                    | That Telegram account belongs to another SkyBOT account with wallets. Sign in with the original login                                                                              |
| Webhook `last_error_message: 401`                     | `TELEGRAM_WEBHOOK_SECRET` changed. Rerun step 6                                                                                                                                    |
| "Scheduler unavailable" when scheduling               | Check `QSTASH_TOKEN` (and `QSTASH_URL` for your region)                                                                                                                            |
| Function timeout on scheduled mints                   | Reduce `JOB_LEAD_MS` or raise `maxDuration` (Pro)                                                                                                                                  |
