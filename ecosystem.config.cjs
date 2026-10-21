// pm2 process file. No secrets here: keys come from ENV_FILES (chmod 600) and the process environment.
// Start with:  bash -lc 'cd /workspace/nft-mint-bot && pm2 start ecosystem.config.cjs'
const ROOT = __dirname;
module.exports = {
  apps: [
    {
      name: "nft-mint-api",
      cwd: `${ROOT}/server`,
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        ENV_FILES: process.env.ENV_FILES || "/workspace/secrets/rpc.env",
        DATA_DIR: process.env.DATA_DIR || "/workspace/nft-mint-bot-data",
        API_HOST: "127.0.0.1",
        API_PORT: "4000",
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
      env: { NODE_ENV: "production", API_URL: "http://127.0.0.1:4000" },
      autorestart: true, max_restarts: 20, restart_delay: 3000,
      merge_logs: true, time: true,
    },
  ],
};
