// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only `/check <OpenSea link | contract address>`: drop summary + per-wallet eligibility in chat.
 * Uses the dashboard's eligibility engine. Never mints or sends anything (at most an off-chain OpenSea sign-in).
 */
import { isValidTimeZone } from "../util/time.js";
import type { ResolvedTarget } from "../core/resolver/resolver.js";
import type { EligibilityRow } from "../core/mint/eligibility.js";
import { groupByStage, nameList, summarizeGroup } from "../core/mint/stageEligibility.js";

import { displayStages, dropHeader, esc, fmtInt, shortAddr, stageHeadLine, stageTimeLine } from "./format.js";
export { esc };

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

export interface CheckView {
  target: ResolvedTarget;
  rows: EligibilityRow[];
  targetStage: { label: string | null; type?: string | null; start: string | null; active: boolean } | null;
  timeZone: string | null;
  now?: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Telegram HTML message(s), each ≤ 3900 chars. One section per allowlist phase (soonest first) with its own price,
 * limit, time and count; eligible wallets listed, the rest collapsed into count lines. Public stages: one line each.
 * Long output splits between sections, never inside one.
 */
export function formatCheck(v: CheckView): string[] {
  const now = v.now ?? Date.now();
  const tz = isValidTimeZone(v.timeZone ?? undefined) ? v.timeZone! : null;
  const t = v.target;
  const sym = t.chain.nativeSymbol;
  const groups = v.rows.length ? groupByStage(t.stages, v.rows, v.targetStage) : [];
  const grouped = new Set(groups.map((g) => g.stage));
  const blocks: string[][] = [];

  const head: string[] = [];
  if (!v.rows.length) head.push("<b>No wallets yet</b> — add wallets in SkyBOT to check eligibility.");
  else if (groups.length) head.push(`<b>${groups.map((g) => `${esc(g.stage.name)}: ${g.eligible}/${g.total}`).join(" · ")}</b> eligible`);
  else {
    const ok = v.rows.filter((r) => verdict(r).label === "Eligible").length;
    head.push(`<b>${ok} of ${plural(v.rows.length, "wallet")} eligible</b>`);
  }
  head.push("", ...dropHeader(t));
  blocks.push(head);

  for (const g of groups) {
    const s = g.stage;
    const sum = summarizeGroup(g);
    const b = ["", stageHeadLine(s, sym), stageTimeLine(s, tz, now)];
    for (const w of sum.eligible)
      b.push(
        `✅ ${esc(w.label)} <code>${shortAddr(w.address)}</code>${w.max ? ` (max ${fmtInt(w.max)})` : ""}${w.note ? ` · ${esc(w.note)}` : ""}`,
      );
    if (sum.notEligible.length) {
      if (!sum.eligible.length && !sum.unknown.length)
        b.push(g.total === 1 ? `❌ Not eligible: ${esc(sum.notEligible[0]!.label)}` : `❌ None of your ${g.total} wallets are eligible`);
      else b.push(`❌ ${sum.notEligible.length} not eligible${esc(nameList(sum.notEligible))}`);
    }
    if (sum.unknown.length) {
      const what = sum.unknown.every((w) => w.state === "unverified") ? "not verified yet" : "unknown";
      b.push(`❔ ${sum.unknown.length} ${what}${esc(nameList(sum.unknown))}`);
    }
    blocks.push(b);
  }

  // Everything that isn't a phase section (Public, ended, or no wallets yet): same two-line block per stage.
  const rest = displayStages(t.stages).filter((s) => !grouped.has(s));
  if (rest.length && groups.length) blocks.push(["", "<b>Other stages</b>"]);
  for (const s of rest) blocks.push(["", stageHeadLine(s, sym), stageTimeLine(s, tz, now)]);

  if (!groups.length && v.rows.length) {
    const b = ["", "<b>Wallets</b>"];
    for (const r of v.rows) {
      const x = verdict(r);
      b.push(
        `${ICON[x.label]} ${esc(r.label)} <code>${shortAddr(r.address)}</code> — ${x.label.toLowerCase()}${x.why ? ` (${esc(x.why)})` : ""}`,
      );
    }
    blocks.push(b);
  }

  const foot: string[] = [];
  const unverified = new Set(groups.flatMap((g) => g.wallets.filter((w) => w.state === "unverified").map((w) => w.walletId)));
  for (const r of v.rows) if (r.needsOpenSeaLogin) unverified.add(r.walletId);
  if (unverified.size)
    foot.push("", `❔ ${plural(unverified.size, "wallet")} not verified yet. Open SkyBOT once and future checks run automatically.`);
  foot.push("", tz ? `<i>Times in ${esc(tz)}. Read-only check, nothing was sent.</i>` : "<i>Times in UTC. Open SkyBOT once to use your own time zone. Read-only check, nothing was sent.</i>");
  blocks.push(foot);
  return splitBlocks(blocks);
}

/** Pack blocks (sections) into messages ≤ max chars; a block larger than max falls back to line splitting. */
export function splitBlocks(blocks: string[][], max = 3900): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const len = (ls: string[]) => ls.join("\n").length;
  for (const b of blocks) {
    if (cur.length && len([...cur, ...b]) > max) {
      out.push(cur.join("\n").trim());
      cur = [];
    }
    if (len(b) > max) {
      out.push(
        ...splitMessage(
          b.filter((l, i) => i > 0 || l !== ""),
          max,
        ),
      );
      continue;
    }
    cur.push(...(cur.length ? b : b.filter((l, i) => i > 0 || l !== "")));
  }
  if (cur.length) out.push(cur.join("\n").trim());
  return out.filter(Boolean);
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
