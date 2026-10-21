import { env } from "./config/env.js";
import { buildServer } from "./api/server.js";
import { startWorker } from "./worker/worker.js";
import { startTelegram } from "./bot/telegram.js";
import { log } from "./util/log.js";
import { CHAINS, rpcsForChain } from "./config/chains.js";

async function main() {
  const app = await buildServer();
  startWorker();
  await startTelegram();
  await app.listen({ host: env.apiHost, port: env.apiPort });
  log.info(`API listening on http://${env.apiHost}:${env.apiPort}`);
  for (const c of CHAINS) {
    const r = rpcsForChain(c);
    log.info(`chain ${c.key} (${c.chainId}): ${r.hasPrivate ? "private RPC + " : ""}${r.read.length} read / ${r.send.length} send endpoints`);
  }
  if (!env.openseaApiKey) log.warn("OPENSEA_API_KEY not set: slug lookups may fail, allowlist checks and OpenSea mint API disabled");
  if (!env.etherscanApiKey) log.warn("ETHERSCAN_API_KEY not set: ABI lookup falls back to Blockscout/Sourcify/bytecode probe");
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
main().catch((e) => { log.error("fatal", e); process.exit(1); });
