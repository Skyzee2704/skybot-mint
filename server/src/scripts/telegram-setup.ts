// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-deploy setup (run once per deployment URL, from a machine with the production env):
 *   - Telegram: setWebhook (secret_token), commands, description, Mini App menu button
 *   - QStash: housekeeping cron → /api/cron/housekeeping
 * Usage: PUBLIC_URL=https://… TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… QSTASH_TOKEN=… npm run telegram:setup
 */
import { setupTelegramWebhook } from "../bot/telegram.js";
import { ensureHousekeepingSchedule } from "../jobs/scheduler.js";
const r = { ...(await setupTelegramWebhook()), ...(await ensureHousekeepingSchedule()) };
console.log(JSON.stringify(r, null, 2));
process.exit(0);
