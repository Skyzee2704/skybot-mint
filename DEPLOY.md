# Deploy SkyBOT Mint (Vercel + Railway/Render + Neon)

Gue nulis ini biar lo bisa push ke GitHub, web di Vercel, API di Railway/Render, DB di Neon.

## Arsitektur

- **web/** → Vercel (Next.js). Root Directory di Vercel = `web`.
- **server/** (API + worker + Telegram) → Railway atau Render via `Dockerfile` di root.
- **DB** → Neon Postgres (`DATABASE_URL`). Lokal tetap bisa SQLite (kosongin `DATABASE_URL`).
- **Mini App** butuh `PUBLIC_URL=https://…` (domain Vercel lo).

## 1. Push ke GitHub

```bash
cd /workspace/nft-mint-bot
git add -A
git status   # pastikan .env / secrets/ / *.db gak ke-track
git commit -m "SkyBOT Mint multi-user + deploy"
# buat repo di GitHub, terus:
git remote add origin git@github.com:USER/skybot-mint.git
git push -u origin main
```

## 2. Neon (Postgres)

1. https://neon.tech → New project
2. Copy connection string (`postgresql://…?sslmode=require`)
3. Nanti tempel ke Railway/Render sebagai `DATABASE_URL`

## 3. Railway (API) — rekomendasi

1. New Project → Deploy from GitHub → pilih repo
2. Builder: Dockerfile (ada `railway.json`)
3. Variables (wajib):

| Key | Contoh |
|---|---|
| `DATABASE_URL` | dari Neon |
| `PRIVY_APP_ID` | `cmvhyys6g00ao0gl3sk2o75fy` |
| `PRIVY_APP_SECRET` | dari Privy Dashboard |
| `PUBLIC_URL` | `https://skybot.vercel.app` (isi setelah Vercel) |
| `WEB_ORIGIN` | sama kayak `PUBLIC_URL` |
| `PUBLIC_API_URL` | URL publik Railway (setelah deploy, update) |
| `TELEGRAM_BOT_TOKEN` | dari BotFather |
| `TELEGRAM_BOT_USERNAME` | `MyTradeSkyBOT` |
| `TELEGRAM_WEBHOOK_SECRET` | string random panjang |
| `OPENSEA_API_KEY` / `ETHERSCAN_API_KEY` | opsional tapi recommended |
| `ADMIN_EMAILS` | email lo |
| `PRIVY_AUTH_PRIVATE_KEY` + `PRIVY_AUTH_KEY_QUORUM_ID` | buat scheduled mint |

4. Health check: `/api/health`
5. Setelah dapat domain Railway, set `PUBLIC_API_URL=https://xxx.up.railway.app` → redeploy (bot pindah ke webhook).

**Render:** sama, pakai `render.yaml` atau Docker + health `/api/health`.

## 4. Vercel (Web)

1. Import repo → **Root Directory = `web`**
2. Framework: Next.js
3. Env:

| Key | Value |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | `cmvhyys6g00ao0gl3sk2o75fy` |
| `NEXT_PUBLIC_API_URL` | `https://xxx.up.railway.app` (tanpa slash akhir) |

4. Deploy → catat URL (`https://….vercel.app`)
5. Update di Railway: `PUBLIC_URL` + `WEB_ORIGIN` = URL Vercel → redeploy API

## 5. Privy Dashboard

https://dashboard.privy.io → app **SkyBOT Mint**

1. **Login methods:** Email ON; Google ON (skarang masih OFF di API — nyalain); Telegram ON buat Mini App
2. **Telegram:** tempel bot token + handle `@MyTradeSkyBOT`; enable **seamless auth**
3. **Allowed origins / domains:**
   - `https://your-app.vercel.app`
   - `http://localhost:3000` (dev)
   - `https://web.telegram.org` + `http://web.telegram.org`
4. **Embedded wallets:** create on login = users without wallets (atau all users)
5. **Session signer:** authorization key + key quorum → set `PRIVY_AUTH_*` di API; policy: allow SeaDrop `0x00005EA0…`, max value, chain IDs; deny approve/transfer

## 6. BotFather (Telegram)

1. `/setdomain` → bot → host Vercel **tanpa** `https://` (mis. `skybot.vercel.app`)
2. Menu button: API set otomatis kalau `PUBLIC_URL` https publik; atau `/setmenubutton` → URL = `https://skybot.vercel.app`
3. `/setuserpic` → upload `assets/logo-512.png`
4. Di chat bot: /start → tombol **Buka Dashboard** buka Mini App

## 7. Link akun (tanpa domain publik juga jalan)

**Web → Telegram:** Settings → Generate deep link → buka `https://t.me/MyTradeSkyBOT?start=link_<code>`

**Telegram → Web:** di bot ketik `/link` → tempel kode di Settings

Unlink: Settings atau `/unlink`

## 8. Lokal (pm2) — testing gue

```bash
cd /workspace/nft-mint-bot
npm run build
bash -lc 'pm2 restart ecosystem.config.cjs --update-env'
# atau first start:
# bash -lc 'pm2 start ecosystem.config.cjs && pm2 save'
```

Lokal: SQLite di `DATA_DIR`, Telegram **polling** (jangan set `PUBLIC_API_URL`).

## Checklist cepat

- [ ] `.env` gak ke-push
- [ ] Vercel `NEXT_PUBLIC_*` doang di client
- [ ] Railway punya secret lengkap
- [ ] CORS / Privy origins = Vercel URL
- [ ] BotFather domain = Vercel host
- [ ] `/api/health` hijau
