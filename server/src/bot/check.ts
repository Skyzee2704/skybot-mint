// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only `/check <OpenSea link | contract address>`: drop summary + per-wallet eligibility in chat.
 * Uses the dashboard's eligibility engine. Never signs, mints or sends anything.
 */
import { formatEther } from "ethers";
import { formatDateTime, isValidTimeZone } from "../util/time.js";
import type { ResolvedTarget } from "../core/resolver/resolver.js";
import type { EligibilityRow } from "../core/mint/eligibility.js";
import { sortStages } from "../core/resolver/stageOrder.js";

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

/** Per-wallet verdicts carry only start times: treat past starts as live so they sort first. */
function stageStatus(s: { start?: string | null }, now: number) {
  return s.start && Date.parse(s.start) > now ? "upcoming" : s.start ? "active" : "unknown";
}

function stageLine(s: ResolvedTarget["stages"][number], sym: string, tz: string | null, now: number) {
  const price = s.priceWei !== null ? (s.priceWei === "0" ? "Free" : `${formatEther(s.priceWei)} ${sym}`) : "price unknown";
  const limit = s.maxPerWallet ? ` · max ${s.maxPerWallet}/wallet` : "";
  let when = "";
  if (s.status === "upcoming" && s.start) when = `starts ${formatDateTime(s.start, { timeZone: tz, now })}`;
  else if (s.status === "active") when = s.end ? `live · ends ${formatDateTime(s.end, { timeZone: tz, now })}` : "live now";
  else if (s.status === "ended") when = s.end ? `ended ${formatDateTime(s.end, { timeZone: tz, now })}` : "ended";
  else if (s.start) when = formatDateTime(s.start, { timeZone: tz, now });
  return `• <b>${esc(s.name)}</b> — ${price}${limit}${when ? `\n   ${when}` : ""}`;
}

function verdict(r: EligibilityRow): { label: "Eligible" | "Not eligible" | "Unknown"; why: string } {
  if (r.needsOpenSeaLogin) return { label: "Unknown", why: "open app once to verify" };
  const a = r.access;
  const other = r.reasons.filter((x) => !x.startsWith("insufficient balance") && !x.startsWith("not allowlisted"));
  if (a.status === "no") return { label: "Not eligible", why: a.detail ?? "not on the allowlist" };
  if (other.length) return { label: "Not eligible", why: other[0] };
  if (a.status === "yes" || a.status === "public")
    return { label: "Eligible", why: a.status === "public" ? "public stage" : (a.detail ?? "on the allowlist") };
  if (a.status === "n/a" && r.simulation?.ok === true) return { label: "Eligible", why: "simulation passes" };
  return { label: "Unknown", why: a.detail ?? r.simulation?.reason ?? "can't be determined yet" };
}

const ICON = { Eligible: "✅", "Not eligible": "❌", Unknown: "❔" } as const;

export interface CheckView {
  target: ResolvedTarget;
  rows: EligibilityRow[];
  targetStage: { label: string | null; start: string | null; active: boolean } | null;
  timeZone: string | null;
  now?: number;
}

/** Telegram HTML message(s), each ≤ 3900 chars, split on line boundaries. */
export function formatCheck(v: CheckView): string[] {
  const now = v.now ?? Date.now();
  const tz = isValidTimeZone(v.timeZone ?? undefined) ? v.timeZone! : null;
  const t = v.target;
  const sym = t.chain.nativeSymbol;
  const stageName =
    v.targetStage?.label ??
    (t.stages.find((s) => s.status === "active") ?? t.stages.find((s) => s.status === "upcoming"))?.name ??
    "this drop";
  const verdicts = v.rows.map((r) => ({ r, v: verdict(r) }));
  const ok = verdicts.filter((x) => x.v.label === "Eligible").length;
  const unknown = verdicts.filter((x) => x.v.label === "Unknown").length;

  const lines: string[] = [];
  lines.push(
    v.rows.length
      ? `<b>${ok} of ${v.rows.length} wallet${v.rows.length === 1 ? "" : "s"} eligible for ${esc(stageName)}</b>${unknown ? ` · ${unknown} unknown` : ""}`
      : "<b>No wallets yet</b> — add wallets in SkyBOT to check eligibility.",
  );
  lines.push("");
  lines.push(`<b>${esc(t.name ?? "Unknown collection")}</b> on ${esc(t.chain.name)}`);
  lines.push(`<code>${t.contract}</code>`);
  if (t.supply.max || t.supply.total) lines.push(`Supply: ${t.supply.total ?? "?"} / ${t.supply.max ?? "?"}`);
  if (t.stages.length) {
    lines.push("", "<b>Stages</b>");
    for (const s of sortStages(t.stages)) lines.push(stageLine(s, sym, tz, now));
  }
  if (v.rows.length) {
    lines.push("", `<b>Wallets</b> (${esc(stageName)})`);
    for (const { r, v: x } of verdicts) {
      const per =
        r.stages && r.stages.length > 1
          ? `\n   ${sortStages(r.stages.map((s) => ({ ...s, status: stageStatus(s, now) })))
              .map((s) => `${esc(s.label ?? s.type ?? "stage")}: ${s.eligible ? "yes" : s.eligible === false ? "no" : "?"}`)
              .join(" · ")}`
          : "";
      lines.push(
        `${ICON[x.label]} <b>${esc(r.label)}</b> <code>${shortAddr(r.address)}</code> · ${x.label}${x.why ? ` — ${esc(x.why)}` : ""}${per}`,
      );
    }
  }
  if (verdicts.some((x) => x.r.needsOpenSeaLogin))
    lines.push(
      "",
      "Some wallets aren't verified with OpenSea yet. Tap <b>Open in SkyBOT</b> once: wallets are verified automatically (free, no gas).",
    );
  lines.push(
    "",
    tz ? `Times shown in ${esc(tz.replace(/_/g, " "))}.` : "Times shown in UTC. Open SkyBOT once to see times in your own timezone.",
  );
  lines.push("<i>Read-only check. Nothing was signed or sent.</i>");
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
