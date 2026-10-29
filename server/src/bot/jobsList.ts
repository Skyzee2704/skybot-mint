// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /jobs in Telegram: a menu ([Active Jobs] [History]) and paged lists, 5 jobs per page, edited in place.
 * Pure helpers (unit-tested); telegram.ts wires them to the bot. HTML parse mode, escaped with esc().
 *
 *   🟢 <b>Active jobs</b> · 1/3
 *
 *   1. ⏳ <b>ethernal-cubs</b> · base
 *      <code>a1b2c3d4</code> · 3 wallets
 *      🕒 runs Fri, 30 Oct · 22:00 (UTC+8)
 */
import { InlineKeyboard } from "grammy";
import { esc } from "./check.js";
import { formatDateTime } from "../util/time.js";
import type { JobRecord } from "../core/jobs/repo.js";

export const JOBS_PAGE_SIZE = 5;
export type JobsTab = "a" | "h";
const ACTIVE = new Set(["scheduled", "waiting_unlock", "running"]);
export const isActiveJob = (j: Pick<JobRecord, "status">) => ACTIVE.has(j.status);

const STATUS: Record<string, [string, string]> = {
  scheduled: ["⏳", "Scheduled"],
  waiting_unlock: ["🔒", "Waiting"],
  running: ["⚙️", "Running"],
  done: ["✅", "Done"],
  failed: ["❌", "Failed"],
  cancelled: ["🚫", "Cancelled"],
};
export const statusBadge = (s: string) => {
  const [e, l] = STATUS[s] ?? ["•", s];
  return `${e} ${l}`;
};

/** Clamp the page and slice. Pages are 0-based internally. */
export function paginate<T>(items: readonly T[], page: number, size = JOBS_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), pages - 1);
  return { page: p, pages, items: items.slice(p * size, p * size + size), total: items.length };
}

/** "Done · 2/3 minted · #25, #26" style summary for finished jobs. */
export function resultSummary(j: Pick<JobRecord, "status" | "results" | "error">): string {
  const rs = Array.isArray(j.results) ? j.results : [];
  const ok = rs.filter((r: any) => r?.status === "confirmed");
  const ids = ok.flatMap((r: any) => (Array.isArray(r?.tokenIds) ? r.tokenIds : [])).map((t: any) => `#${t}`);
  const parts: string[] = [];
  if (rs.length) parts.push(`${ok.length}/${rs.length} minted`);
  if (ids.length) parts.push(ids.length > 4 ? `${ids.slice(0, 4).join(", ")} +${ids.length - 4}` : ids.join(", "));
  if (!ok.length && j.error) parts.push(String(j.error).length > 80 ? `${String(j.error).slice(0, 79)}…` : String(j.error));
  return parts.join(" · ");
}

const jobName = (j: Pick<JobRecord, "request" | "target">) => {
  const slug = (j.request as any)?.slug;
  return typeof slug === "string" && slug ? slug : `${j.target.slice(0, 6)}…${j.target.slice(-4)}`;
};
const walletCount = (j: Pick<JobRecord, "request">) => {
  const n = Array.isArray((j.request as any)?.wallets) ? (j.request as any).wallets.length : 0;
  return `${n} wallet${n === 1 ? "" : "s"}`;
};

export function formatJobLine(j: JobRecord, n: number, timeZone: string | null, now = Date.now()): string {
  const at = j.runAt ?? j.startedAt ?? j.createdAt;
  const verb = j.runAt ? (new Date(j.runAt).getTime() > now ? "runs" : "ran") : "created";
  const lines = [
    `${n}. ${statusBadge(j.status)} · <b>${esc(jobName(j))}</b> · ${esc(j.chain)}`,
    `   <code>${esc(j.id.slice(0, 8))}</code> · ${walletCount(j)}`,
    `   🕒 ${verb} ${esc(formatDateTime(j.runAt ?? at, { timeZone, now, compactYear: true }))}`,
  ];
  if (!isActiveJob(j)) {
    const s = resultSummary(j);
    if (s) lines.push(`   ${esc(s)}`);
  }
  return lines.join("\n");
}

export const JOBS_MENU_TEXT = "📋 <b>Your mints</b>\nChoose a list:";
export const jobsMenuKeyboard = () => new InlineKeyboard().text("🟢 Active Jobs", "jl:a:0").text("📜 History", "jl:h:0");

export function parseJobsCallback(data: string): { tab: JobsTab; page: number } | "menu" | null {
  if (data === "jl:m") return "menu";
  const m = /^jl:([ah]):(\d{1,4})$/.exec(data);
  return m ? { tab: m[1] as JobsTab, page: Number(m[2]) } : null;
}

/** Text + keyboard for one page. `cancellable` decides which jobs get a Cancel button (active tab only). */
export function renderJobsPage(
  all: readonly JobRecord[],
  tab: JobsTab,
  page: number,
  opts: { timeZone: string | null; now?: number; cancellable?: (j: JobRecord) => boolean },
) {
  const list = all.filter((j) => (tab === "a" ? isActiveJob(j) : !isActiveJob(j)));
  const pg = paginate(list, page);
  const title = tab === "a" ? "🟢 <b>Active jobs</b>" : "📜 <b>History</b>";
  const kb = new InlineKeyboard();
  let text: string;
  if (!pg.total) {
    text = `${title}\n\n${tab === "a" ? "No active or scheduled mints." : "No finished mints yet."}`;
  } else {
    const base = pg.page * JOBS_PAGE_SIZE;
    text = [
      `${title} · ${pg.page + 1}/${pg.pages}`,
      "",
      pg.items.map((j, i) => formatJobLine(j, base + i + 1, opts.timeZone, opts.now)).join("\n\n"),
    ].join("\n");
    if (tab === "a" && opts.cancellable)
      pg.items.forEach((j, i) => {
        if (opts.cancellable!(j)) kb.text(`✖ Cancel #${base + i + 1}`, `jc:${j.id}`).row();
      });
    if (pg.pages > 1) {
      kb.text(pg.page > 0 ? "◀ Prev" : " ", pg.page > 0 ? `jl:${tab}:${pg.page - 1}` : "jl:noop");
      kb.text(`${pg.page + 1}/${pg.pages}`, "jl:noop");
      kb.text(pg.page < pg.pages - 1 ? "Next ▶" : " ", pg.page < pg.pages - 1 ? `jl:${tab}:${pg.page + 1}` : "jl:noop");
      kb.row();
    }
  }
  if (!opts.timeZone) text += "\n\n<i>Times in UTC. Open SkyBOT once to see your own timezone.</i>";
  kb.text("⬅ Back", "jl:m");
  return { text, keyboard: kb, page: pg.page, pages: pg.pages };
}
