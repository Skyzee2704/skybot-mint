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
    const results = j.results as any[];
    const ok = results.filter((r) => r.status === "confirmed");
    const cancelled = j.status === "cancelled";
    const title =
      j.status === "done"
        ? "Mint finished"
        : j.status === "failed"
          ? "Mint failed"
          : cancelled
            ? "Mint cancelled"
            : `Mint ${esc(j.status)}`;
    const lines = [
      `<b>${title}</b> · ${esc(j.chain)} <code>${j.target.slice(0, 6)}…${j.target.slice(-4)}</code>`,
      ...(cancelled ? [] : [`${ok.length} of ${results.length} wallet(s) minted`]),
      ...(cancelled ? [] : results).map(
        (r) =>
          `${r.status === "confirmed" ? "✅" : "❌"} <code>${String(r.address).slice(0, 6)}…${String(r.address).slice(-4)}</code> ${esc(r.status)}${
            (r.tokenIds ?? []).length ? ` · #${(r.tokenIds as string[]).join(", #")}` : ""
          }${r.explorer ? ` · <a href="${esc(r.explorer)}">tx</a>` : ""}${r.error ? ` · ${esc(String(r.error).slice(0, 120))}` : ""}`,
      ),
      ...(j.error ? [esc(j.error)] : []),
    ];
    const msg = lines.join("\n").slice(0, 3900);
    await new Api(env.telegramBotToken).sendMessage(u.telegramUserId, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (e: any) {
    log.warn("telegram notify failed", redactString(String(e?.message ?? e)));
  }
}
