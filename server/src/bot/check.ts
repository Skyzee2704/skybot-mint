// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only `/check <OpenSea link | contract address>`: drop summary + per-wallet eligibility in chat.
 * Uses the dashboard's eligibility engine. Never mints or sends anything (at most an off-chain OpenSea sign-in).
 */
import { formatEther } from "ethers";
import { formatDateTime, isValidTimeZone } from "../util/time.js";
import type { ResolvedTarget } from "../core/resolver/resolver.js";
import type { EligibilityRow } from "../core/mint/eligibility.js";
import { sortStages } from "../core/resolver/stageOrder.js";
import { groupByStage, verdictText } from "../core/mint/stageEligibility.js";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const CHAIN_WORD = /^[a-z][a-z0-9-]{1,20}$/i;

/**
 * Accepts: OpenSea collection/item link, 0x contract, "base:0x…", "0x… base", "base 0x…", or an OpenSea slug.
 * Returns null when nothing usable was given.
 */
export function parseCheckArgs(text: string): { input: string; chain?: string } | null {
  const arg = text
    .replace(/^\/check(@\w+)?/i, "")
    .trim()
    .replace(/[<>]/g, "");
  if (!arg || arg.length > 300) return null;
  const parts = arg.split(/\s+/).filter(Boolean);
  const colon = /^([a-z][a-z0-9-]{1,20}):(0x[0-9a-fA-F]{40})$/i.exec(parts[0]);
  if (colon) return { input: colon[2], chain: colon[1].toLowerCase() };
  if (parts.length >= 2) {
    const addrIdx = parts.findIndex((p) => /^0x[0-9a-fA-F]{40}$/.test(p) || /^https?:\/\//i.test(p));
    if (addrIdx >= 0) {
      const other = parts.find((p, i) => i !== addrIdx && CHAIN_WORD.test(p));
      return { input: parts[addrIdx], chain: other?.toLowerCase() };
    }
  }
  const one = parts[0];
  if (/^https?:\/\//i.test(one) || /^0x[0-9a-fA-F]{40}$/.test(one) || /^[a-z0-9][a-z0-9-_]{1,99}$/i.test(one)) return { input: one };
  return null;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function stageLine(s: ResolvedTarget["stages"][number], sym: string, tz: string | null, now: number) {
  const price = s.priceWei !== null ? (s.priceWei === "0" ? "Free" : `${formatEther(s.priceWei)} ${sym}`) : "price unknown";
  const limit = s.maxPerWallet ? ` · max ${s.maxPerWallet}/wallet` : "";
  const when = stageWhen(s, tz, now);
  return `• <b>${esc(s.name)}</b> — ${price}${limit}${when ? `\n   ${when}` : ""}`;
}

function verdict(r: EligibilityRow): { label: "Eligible" | "Not eligible" | "Unknown"; why: string } {
  if (r.needsOpenSeaLogin) return { label: "Unknown", why: "not verified yet" };
  const a = r.access;
  const other = r.reasons.filter((x) => !x.startsWith("insufficient balance") && !x.startsWith("not allowlisted"));
  if (a.status === "no") return { label: "Not eligible", why: "" };
  if (other.length) return { label: "Not eligible", why: other[0] };
  if (a.status === "yes" || a.status === "public") return { label: "Eligible", why: "" };
  if (a.status === "n/a" && r.simulation?.ok === true) return { label: "Eligible", why: "" };
  return { label: "Unknown", why: "" };
}

const ICON = { Eligible: "✅", "Not eligible": "❌", Unknown: "❔" } as const;
const STATE_ICON = { eligible: "✅", not_eligible: "❌", unverified: "❔", unknown: "❔" } as const;

export interface CheckView {
  target: ResolvedTarget;
  rows: EligibilityRow[];
  targetStage: { label: string | null; type?: string | null; start: string | null; active: boolean } | null;
  timeZone: string | null;
  now?: number;
}

function stageWhen(s: ResolvedTarget["stages"][number], tz: string | null, now: number) {
  if (s.status === "upcoming" && s.start) return `starts ${formatDateTime(s.start, { timeZone: tz, now })}`;
  if (s.status === "active") return s.end ? `live · ends ${formatDateTime(s.end, { timeZone: tz, now })}` : "live now";
  if (s.status === "ended") return s.end ? `ended ${formatDateTime(s.end, { timeZone: tz, now })}` : "ended";
  return s.start ? formatDateTime(s.start, { timeZone: tz, now }) : "";
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Telegram HTML message(s), each ≤ 3900 chars, split on line boundaries. */
export function formatCheck(v: CheckView): string[] {
  const now = v.now ?? Date.now();
  const tz = isValidTimeZone(v.timeZone ?? undefined) ? v.timeZone! : null;
  const t = v.target;
  const sym = t.chain.nativeSymbol;
  const groups = v.rows.length ? groupByStage(t.stages, v.rows, v.targetStage) : [];
  const unverified = new Set(groups.flatMap((g) => g.wallets.filter((w) => w.state === "unverified").map((w) => w.walletId)));

  const lines: string[] = [];
  if (!v.rows.length) lines.push("<b>No wallets yet</b> — add wallets in SkyBOT to check eligibility.");
  else if (groups.length)
    lines.push(`<b>${groups.map((g) => `${esc(g.stage.name)}: ${g.eligible} of ${g.total} eligible`).join(" · ")}</b>`);
  else {
    // No allowlist stage (public or on-chain mint): one overall verdict per wallet.
    const ok = v.rows.filter((r) => verdict(r).label === "Eligible").length;
    lines.push(`<b>${ok} of ${plural(v.rows.length, "wallet")} eligible</b>`);
  }
  lines.push("");
  lines.push(`<b>${esc(t.name ?? "Unknown collection")}</b> on ${esc(t.chain.name)}`);
  lines.push(`<code>${t.contract}</code>`);
  if (t.supply.max || t.supply.total) lines.push(`Supply: ${t.supply.total ?? "?"} / ${t.supply.max ?? "?"}`);
  if (t.stages.length) {
    lines.push("", "<b>Stages</b>");
    for (const s of sortStages(t.stages)) lines.push(stageLine(s, sym, tz, now));
  }
  if (groups.length) {
    for (const g of groups) {
      const when = stageWhen(g.stage, tz, now);
      lines.push("", `<b>${esc(g.stage.name)}</b>${when ? ` — ${when}` : ""}`);
      for (const w of g.wallets)
        lines.push(`${STATE_ICON[w.state]} ${esc(w.label)} <code>${shortAddr(w.address)}</code> — ${esc(verdictText(w))}`);
    }
  } else if (v.rows.length) {
    lines.push("", "<b>Wallets</b>");
    for (const r of v.rows) {
      const x = verdict(r);
      lines.push(
        `${ICON[x.label]} ${esc(r.label)} <code>${shortAddr(r.address)}</code> — ${x.label.toLowerCase()}${x.why ? ` (${esc(x.why)})` : ""}`,
      );
    }
  }
  if (unverified.size || v.rows.some((r) => r.needsOpenSeaLogin))
    lines.push(
      "",
      `❔ ${plural(Math.max(unverified.size, v.rows.filter((r) => r.needsOpenSeaLogin).length), "wallet")} not verified yet. Open SkyBOT once and future checks run automatically.`,
    );
  lines.push("", tz ? `Times shown in ${esc(tz.replace(/_/g, " "))}.` : "Times shown in UTC. Open SkyBOT once to use your own time zone.");
  lines.push("<i>Read-only check. No transactions were sent.</i>");
  return splitMessage(lines);
}

export function splitMessage(lines: string[], max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    const piece = l.length > max ? l.slice(0, max - 1) + "…" : l;
    if (cur && cur.length + piece.length + 1 > max) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}
