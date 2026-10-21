// SPDX-License-Identifier: AGPL-3.0-only
/** Offline Telegram handler test: feeds fake updates, captures replies instead of sending. Read-only network (resolver). */
import { createBot } from "../src/bot/telegram.js";
const USER = 111111;
const OTHER = 222222;
const bot = createBot("123456:TEST", String(USER), {
  botInfo: {
    id: 1,
    is_bot: true,
    first_name: "t",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as any,
});
const sent: { chat: number; text: string; parse_mode?: string }[] = [];
bot.api.config.use(async (_prev, method, payload: any) => {
  if (method === "sendMessage") sent.push({ chat: payload.chat_id, text: payload.text, parse_mode: payload.parse_mode });
  return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } } as any;
});
let id = 1;
const msg = (from: number, text: string) => ({
  update_id: id++,
  message: {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: from, type: "private" as const, first_name: "u" },
    from: { id: from, is_bot: false, first_name: "u" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0].length }] } : {}),
  },
});
for (const [from, text] of [
  [OTHER, "/start"],
  [USER, "/start"],
  [USER, "/status"],
  [USER, "/jobs"],
  [USER, "/foo"],
  [USER, "cosmic-hitchhikers"],
  [USER, "https://opensea.io/assets/ethereum/0x06ea2bf75bedc071be4c20361656c665145b38d4/1"],
  [USER, "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8 ethereum"],
] as [number, string][]) {
  const before = sent.length;
  await bot.handleUpdate(msg(from, text) as any);
  console.log(`--- from ${from === USER ? "OWNER" : "STRANGER"}: ${text}`);
  console.log(
    sent.length === before
      ? "(no reply)"
      : sent
          .slice(before)
          .map((s) => `[${s.parse_mode ?? "plain"}] ${s.text}`)
          .join("\n"),
  );
}
