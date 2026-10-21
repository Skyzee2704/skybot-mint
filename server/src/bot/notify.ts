// SPDX-License-Identifier: AGPL-3.0-only
/** Job notifications to the owner's linked Telegram — stateless (works in serverless). */
import { Api } from "grammy";
import { env } from "../config/env.js";
import { getJob } from "../core/jobs/repo.js";
import { log, redactString } from "../util/log.js";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export async function notifyJobDone(jobId: string) {
  if (!env.telegramBotToken) return;
  try {
    const j = await getJob(null, jobId);
    if (!j) return;
    const { requireUser } = await import("../users/service.js");
    const u = await requireUser(j.userId).catch(() => null);
    if (!u?.telegramUserId) return;
    const ok = (j.results as any[]).filter((r) => r.status === "confirmed");
    const msg = `<b>Job ${esc(j.status)}</b>\n${esc(j.chain)} <code>${j.target}</code>\n${ok.length} wallet(s) minted${ok.length ? ": " + ok.map((r) => `<code>${r.address.slice(0, 8)}…</code> [${(r.tokenIds ?? []).join(",")}]`).join("; ") : ""}${j.error ? "\n" + esc(j.error) : ""}`;
    await new Api(env.telegramBotToken).sendMessage(u.telegramUserId, msg, { parse_mode: "HTML" });
  } catch (e: any) {
    log.warn("telegram notify failed", redactString(String(e?.message ?? e)));
  }
}
