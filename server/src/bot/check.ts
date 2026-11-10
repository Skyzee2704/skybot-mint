// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only `/check <OpenSea link | contract address>`: drop summary + per-wallet eligibility in chat.
 * Uses the dashboard's eligibility engine. Never mints or sends anything (at most an off-chain OpenSea sign-in).
 */
import { isValidTimeZone } from "../util/time.js";
import type { ResolvedTarget } from "../core/resolver/resolver.js";
import type { EligibilityRow } from "../core/mint/eligibility.js";
import { groupByStage, fundingWarning, nameList, summarizeGroup } from "../core/mint/stageEligibility.js";

import { displayStages, dropHeader, esc, fmtInt, isPublicStage, shortAddr, stageHeadLine, stageTimeLine } from "./format.js";
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
  if (r.needsOpenSeaLogin && r.access.status === "unknown") return { label: "Unknown", why: "belum terverifikasi" };
  const a = r.access;
  const other = r.reasons.filter((x) => !/^insufficient\b/i.test(x) && !x.startsWith("not allowlisted"));
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

/** Headline per phase: unknown wallets never count as "0 eligible" ("Whitelist: 8 unknown", "GTD: 1/3 eligible, 2 unknown"). */
export function headCount(g: { stage: { name: string }; wallets: { state: string }[]; eligible: number; total: number }): string {
  const unknown = g.wallets.filter((w) => w.state === "unknown" || w.state === "unverified").length;
  if (unknown === g.total) return `${g.stage.name}: ${unknown} unknown`;
  return `${g.stage.name}: ${g.eligible}/${g.total} eligible${unknown ? `, ${unknown} unknown` : ""}`;
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
  const kalos = t.dropSource === "kalos";
  const groups = v.rows.length ? groupByStage(t.stages, v.rows, v.targetStage) : [];
  const grouped = new Set(groups.map((g) => g.stage));
  const blocks: string[][] = [];
  const rowById = new Map(v.rows.map((r) => [r.walletId, r]));
  const shownMax = (stage: { maxPerWallet?: number | null }, w: { walletId: string; max: number | null }) => {
    const cap = w.max ?? stage.maxPerWallet ?? null;
    if (cap == null) return null;
    if (!kalos) return w.max;
    return Math.max(0, cap - (rowById.get(w.walletId)?.mintedSoFar ?? 0));
  };
  const fundingLine = (rows: EligibilityRow[]) => {
    const notes = rows.map((r) => fundingWarning(r.reasons)).filter((x): x is string => Boolean(x));
    if (!notes.length) return null;
    if (notes.length === 1) return notes[0];
    return `⚠️ ${notes.length} not enough ${sym} for price + gas`;
  };

  const head: string[] = [];
  if (!v.rows.length) head.push("<b>No wallets yet</b> — add wallets in SkyBOT to check eligibility.");
  else if (groups.length) head.push(`<b>${groups.map((g) => esc(headCount(g))).join(" · ")}</b>`);
  else if (!kalos) {
    const ok = v.rows.filter((r) => verdict(r).label === "Eligible").length;
    head.push(`<b>${ok} of ${plural(v.rows.length, "wallet")} eligible</b>`);
  }
  head.push("", ...dropHeader(t));
  blocks.push(head);

  for (const g of groups) {
    const s = g.stage;
    const sum = summarizeGroup(g);
    const b = ["", stageHeadLine(s, sym), stageTimeLine(s, tz, now)];
    for (const w of sum.eligible) {
      const max = shownMax(s, w);
      b.push(
        `✅ ${esc(w.label)} <code>${shortAddr(w.address)}</code>${max ? ` (max ${fmtInt(max)})` : ""}${w.note ? ` · ${esc(w.note)}` : ""}`,
      );
    }
    if (sum.notEligible.length) {
      if (!sum.eligible.length && !sum.unknown.length)
        b.push(g.total === 1 ? `❌ Not eligible: ${esc(sum.notEligible[0]!.label)}` : `❌ None of your ${g.total} wallets are eligible`);
      else b.push(`❌ ${sum.notEligible.length} not eligible${esc(nameList(sum.notEligible))}`);
    }
    if (sum.unknown.length) {
      const what = sum.unknown.every((w) => w.state === "unverified")
        ? "belum terverifikasi — lihat alasan di bawah"
        : sum.unknown.every((w) => w.state === "unknown")
          ? "unknown (OpenSea gave no verdict for this stage)"
          : "unknown";
      b.push(`❔ ${sum.unknown.length} ${what}${esc(nameList(sum.unknown))}`);
    }
    const low = fundingLine(sum.eligible.map((w) => rowById.get(w.walletId)!).filter(Boolean));
    if (low) b.push(low);
    blocks.push(b);
  }

  // Everything that isn't a phase section (Public, ended, or no wallets yet): same two-line block per stage.
  const rest = displayStages(t.stages).filter((s) => !grouped.has(s));
  if (rest.length && groups.length) blocks.push(["", "<b>Other stages</b>"]);
  for (const s of rest) {
    const b = ["", stageHeadLine(s, sym), stageTimeLine(s, tz, now)];
    if (isPublicStage(s)) {
      const low = fundingLine(v.rows);
      if (low) b.push(low);
    }
    blocks.push(b);
  }

  if (!groups.length && v.rows.length && !kalos) {
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
  for (const r of v.rows) if (r.needsOpenSeaLogin && (!groups.length || r.access.status === "unknown")) unverified.add(r.walletId);
  if (unverified.size) foot.push(...unverifiedNotes(v.rows.filter((r) => unverified.has(r.walletId))));
  foot.push(
    "",
    tz
      ? `<i>Times in ${esc(tz)}. Read-only check, nothing was sent.</i>`
      : "<i>Times in UTC. Open SkyBOT once to use your own time zone. Read-only check, nothing was sent.</i>",
  );
  blocks.push(foot);
  return splitBlocks(blocks);
}

const REASON_TEXT: Record<string, string> = {
  rate_limited: "OpenSea sedang membatasi sign-in saat ini. Jalankan /check lagi semenit lagi; SkyBOT akan sign-in lagi otomatis.",
  no_signer:
    "Pemeriksaan otomatis belum aktif untuk dompet ini. Buka SkyBOT sekali lewat tombol Open: aktifnya diam-diam (hanya sign-in, tidak bisa mengirim transaksi).",
  no_privy_wallet: "Ini bukan dompet SkyBOT (Privy), jadi SkyBOT tidak bisa menandatangani sign-in OpenSea untuk dompet ini.",
  not_configured: "Sign-in OpenSea otomatis tidak tersedia di server ini. Buka SkyBOT untuk memverifikasi.",
  error: "OpenSea tidak menjawab untuk dompet ini. Jalankan /check lagi sebentar lagi; SkyBOT mencoba lagi otomatis.",
  unknown: "SkyBOT belum bisa menandatangani dompet ini ke OpenSea. Jalankan /check lagi; kalau terus terjadi, buka SkyBOT sekali.",
};

/** One line per reason: which wallets, and the one thing that fixes it. */
export function unverifiedNotes(rows: Pick<EligibilityRow, "label" | "unverifiedReason">[]): string[] {
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const k = r.unverifiedReason && REASON_TEXT[r.unverifiedReason] ? r.unverifiedReason : "unknown";
    by.set(k, [...(by.get(k) ?? []), r.label]);
  }
  const out: string[] = [];
  for (const k of ["no_signer", "rate_limited", "error", "unknown", "no_privy_wallet", "not_configured"]) {
    const names = by.get(k);
    if (!names?.length) continue;
    out.push("", `❔ Belum terverifikasi: ${esc(names.join(", "))}. ${REASON_TEXT[k]}`);
  }
  return out;
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
