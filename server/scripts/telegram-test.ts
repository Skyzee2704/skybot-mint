// SPDX-License-Identifier: AGPL-3.0-only
/** One-off: verify the Telegram token (getMe) and send a test message to TELEGRAM_USER_ID only. Never prints the token. */
import { Bot } from "grammy";
import { env } from "../src/config/env.js";
import { redactString } from "../src/util/log.js";
const token = env.telegramBotToken,
  user = env.telegramUserId;
if (!token || !user) {
  console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID not set");
  process.exit(1);
}
const bot = new Bot(token);
try {
  const me = await bot.api.getMe();
  console.log(`getMe ok: @${me.username} (id ${me.id})`);
  const text = process.argv[2] ?? "Bot NFT mint aktif ✅";
  const m = await bot.api.sendMessage(user, text);
  console.log(`sent message ${m.message_id} to configured user (chat type ${m.chat.type})`);
} catch (e: any) {
  console.error("Telegram error:", redactString(String(e?.description ?? e?.message ?? e)));
  process.exit(1);
}
