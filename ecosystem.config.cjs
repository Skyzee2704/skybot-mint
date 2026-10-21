// SPDX-License-Identifier: AGPL-3.0-only
// Local testing with pm2. Production runs on Vercel (see DEPLOY.md). Secrets come from ENV_FILES / the shell, never this file.
const ROOT = __dirname;
const shared = {
  ENV_FILES: process.env.ENV_FILES || `${ROOT}/.env,/workspace/secrets/rpc.env`,
  DATA_DIR: process.env.DATA_DIR || "/workspace/nft-mint-bot-data",
  PUBLIC_URL: process.env.PUBLIC_URL || "http://localhost:3000",
  WEB_ORIGIN: process.env.WEB_ORIGIN || "http://localhost:3000",
};
module.exports = {
  apps: [
    {
      name: "skybot-web", // Next.js: UI + API route handlers (same as Vercel)
      cwd: `${ROOT}/web`,
      script: `${ROOT}/node_modules/next/dist/bin/next`,
      args: "start -p 3000 -H 127.0.0.1",
      env: { NODE_ENV: "production", ...shared },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      merge_logs: true,
      time: true,
    },
    {
      name: "skybot-worker", // Telegram long polling + local QStash emulation
      cwd: `${ROOT}/server`,
      script: "dist/local.js",
      env: { NODE_ENV: "production", ...shared },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      kill_timeout: 8000,
      merge_logs: true,
      time: true,
    },
  ],
};
