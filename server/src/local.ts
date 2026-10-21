// SPDX-License-Identifier: AGPL-3.0-only
/** Local dev process: Telegram long polling + QStash emulation. The API itself is served by Next.js (web/). */
import { ensureDb, dbMode } from "./db/client.js";
import { startPolling } from "./bot/telegram.js";
import { startLocalScheduler, qstashEnabled } from "./jobs/scheduler.js";
import { env, privyConfigured } from "./config/env.js";
import { log } from "./util/log.js";

async function main() {
  await ensureDb();
  log.info(`SkyBOT local worker — DB ${dbMode()}, PUBLIC_URL ${env.publicUrl}`);
  if (!privyConfigured()) log.warn("PRIVY_APP_ID / PRIVY_APP_SECRET not set");
  if (qstashEnabled()) log.info("QSTASH_TOKEN set — scheduling via QStash; local emulation off");
  else startLocalScheduler();
  await startPolling();
}
main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
