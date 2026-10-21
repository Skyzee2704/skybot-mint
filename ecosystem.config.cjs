// pm2 — local testing. Secrets from ENV_FILES + shell env; never commit .env.
const ROOT = __dirname;
module.exports = {
  apps: [
    {
      name: "nft-mint-api",
      cwd: `${ROOT}/server`,
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        ENV_FILES: process.env.ENV_FILES || `${ROOT}/.env,/workspace/secrets/rpc.env`,
        DATA_DIR: process.env.DATA_DIR || "/workspace/nft-mint-bot-data",
        API_HOST: "127.0.0.1",
        API_PORT: "4000",
        PUBLIC_URL: process.env.PUBLIC_URL || "http://localhost:3000",
        WEB_ORIGIN: process.env.WEB_ORIGIN || "http://localhost:3000",
        DASHBOARD_URL: process.env.DASHBOARD_URL || "http://localhost:3000",
      },
      autorestart: true, max_restarts: 20, restart_delay: 3000, kill_timeout: 8000,
      merge_logs: true, time: true,
    },
    {
      name: "nft-mint-web",
      cwd: `${ROOT}/web`,
      script: `${ROOT}/node_modules/next/dist/bin/next`,
      args: "start -p 3000 -H 127.0.0.1",
      env: {
        NODE_ENV: "production",
        API_URL: "http://127.0.0.1:4000",
        NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || "cmvhyys6g00ao0gl3sk2o75fy",
      },
      autorestart: true, max_restarts: 20, restart_delay: 3000,
      merge_logs: true, time: true,
    },
  ],
};
