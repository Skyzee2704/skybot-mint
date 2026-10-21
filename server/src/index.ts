import { buildServer } from "./api/server.js";
import { startWorker } from "./worker/worker.js";
import { startTelegram } from "./bot/telegram.js";
import { env, privyConfigured, configStatus } from "./config/env.js";
import { ensureDb, dbMode } from "./db/client.js";
import { CHAINS, rpcsForChain } from "./config/chains.js";
import { log } from "./util/log.js";

async function main() {
  await ensureDb();
  log.info(`DB mode: ${dbMode()}`);
  const app = await buildServer();
  startWorker();
  await startTelegram();
  const port = Number(process.env.PORT) || env.apiPort;
  const host = process.env.PORT ? "0.0.0.0" : env.apiHost;
  await app.listen({ host, port });
  log.info(`SkyBOT Mint API listening on http://${host}:${port}`);
  log.info(`Public URL: ${env.publicUrl} | WEB_ORIGIN: ${env.webOrigin} | PUBLIC_API_URL: ${env.publicApiUrl ?? "(polling)"}`);
  for (const c of CHAINS) {
    const r = rpcsForChain(c);
    log.info(`chain ${c.key} (${c.chainId}): ${r.hasPrivate ? "private RPC + " : ""}${r.read.length} read / ${r.send.length} send endpoints`);
  }
  const st = configStatus();
  if (!privyConfigured()) log.warn("PRIVY_APP_ID / PRIVY_APP_SECRET not set — auth disabled until configured");
  if (!st.opensea) log.warn("OPENSEA_API_KEY not set");
  if (!st.etherscan) log.warn("ETHERSCAN_API_KEY not set");
  if (!st.telegram) log.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
}

main().catch((e) => { log.error("fatal", e); process.exit(1); });
