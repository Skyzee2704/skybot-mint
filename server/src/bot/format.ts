// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared Telegram (HTML) formatting for drop summaries: /mint, plain links and the /check header use the same
 * compact, phone-friendly layout. Every line is short enough not to wrap on a narrow phone in most cases.
 *
 *   <b>Lil Trenchers</b> · Ethereum
 *   <code>0xD80f…3A08</code> · OpenSea · Explorer
 *   SeaDrop · ERC-721 · Supply 0 / 3,333
 *
 *   <b>Trenchettes Phase</b> · Free · max 3,333
 *   🕒 Fri, 30 Oct · 22:00 (UTC+8) · in 8d 9h
 */
import { formatEther, getAddress } from "ethers";
import { formatDateTime, isValidTimeZone } from "../util/time.js";
import type { ResolvedTarget, Stage } from "../core/resolver/resolver.js";
import { sortStages } from "../core/resolver/stageOrder.js";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

export const checksum = (a: string) => {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
};
export const shortAddr = (a: string) => {
  const c = checksum(a);
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
};

/** "3333" → "3,333"; big integers safe; non-numbers returned as-is. */
export function fmtInt(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined || v === "") return "?";
  try {
    return BigInt(v).toLocaleString("en-US");
  } catch {
    return String(v);
  }
}

export const standardLabel = (s: string) => (s === "erc721" ? "ERC-721" : s === "erc1155" ? "ERC-1155" : "Unknown standard");
export const kindLabel = (t: Pick<ResolvedTarget, "kind">) => (t.kind === "seadrop" ? "SeaDrop" : "Generic");

export const isPublicStage = (s: Pick<Stage, "name" | "type">) => s.type === "public" || /\bpublic\b/i.test(s.name);
export const stageLabel = (s: Pick<Stage, "name" | "type">) => (isPublicStage(s) ? "Public" : s.name || "Stage");

export function priceText(s: Pick<Stage, "priceWei">, sym: string) {
  if (s.priceWei === null) return "Price unknown";
  if (s.priceWei === "0") return "Free";
  return `${formatEther(s.priceWei)} ${sym}`;
}

const tzOf = (tz: string | null | undefined) => (isValidTimeZone(tz ?? undefined) ? tz! : null);
const when = (iso: string, tz: string | null, now: number, relative = true) =>
  formatDateTime(iso, { timeZone: tz, now, compactYear: true, relative });

/** "🕒 Fri, 30 Oct · 22:00 (UTC+8) · in 8d 9h" / "🟢 Live · ends …" / "Ended · …". */
export function stageTimeLine(s: Pick<Stage, "status" | "start" | "end">, timeZone: string | null, now = Date.now()): string {
  const tz = tzOf(timeZone);
  if (s.status === "active") return s.end ? `🟢 Live · ends ${when(s.end, tz, now)}` : "🟢 Live now";
  if (s.status === "ended") return s.end ? `Ended · ${when(s.end, tz, now, false)}` : "Ended";
  if (s.start) return `🕒 ${when(s.start, tz, now)}`;
  return "🕒 Time not announced";
}

/** "<b>Founders Phase</b> · Free · max 25" */
export function stageHeadLine(s: Stage, sym: string): string {
  return `<b>${esc(stageLabel(s))}</b> · ${priceText(s, sym)}${s.maxPerWallet ? ` · max ${fmtInt(s.maxPerWallet)}` : ""}`;
}

/** Display order: live, then upcoming soonest first; Public after the allowlist phases; ended last. */
export function displayStages<T extends Stage>(stages: readonly T[]): T[] {
  const sorted = sortStages(stages);
  const rank = (s: T) => (s.status === "ended" ? 2 : isPublicStage(s) ? 1 : 0);
  return sorted.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}

export function openSeaUrl(t: Pick<ResolvedTarget, "slug" | "opensea">): string | null {
  if (t.slug) return `https://opensea.io/collection/${encodeURIComponent(t.slug)}`;
  return t.opensea?.url ?? null;
}
export const explorerUrl = (t: Pick<ResolvedTarget, "chain" | "contract">) =>
  t.chain.explorer ? `${t.chain.explorer.replace(/\/$/, "")}/address/${checksum(t.contract)}` : null;

/** Three header lines: name · chain / short address · links / kind · standard · supply. */
export function dropHeader(t: ResolvedTarget): string[] {
  const os = openSeaUrl(t);
  const ex = explorerUrl(t);
  const links = [os ? `<a href="${attr(os)}">OpenSea</a>` : null, ex ? `<a href="${attr(ex)}">Explorer</a>` : null].filter(Boolean);
  const { total, max } = t.supply;
  const supply = max && max !== "0" ? `Supply ${fmtInt(total ?? "0")} / ${fmtInt(max)}` : total ? `${fmtInt(total)} minted` : null;
  return [
    `<b>${esc(t.name?.trim() || "Unknown collection")}</b> · ${esc(t.chain.name)}`,
    [`<code>${shortAddr(t.contract)}</code>`, ...links].join(" · "),
    [kindLabel(t), t.standard !== "unknown" ? standardLabel(t.standard) : null, supply].filter(Boolean).join(" · "),
  ];
}

/** Two lines per stage, a blank line between stages. */
export function stageBlock(s: Stage, sym: string, timeZone: string | null, now = Date.now()): string[] {
  return ["", stageHeadLine(s, sym), stageTimeLine(s, timeZone, now)];
}

export const tzNote = (timeZone: string | null | undefined) => {
  const tz = tzOf(timeZone);
  return tz ? `<i>Times in ${esc(tz)}.</i>` : "<i>Times in UTC. Open SkyBOT once to use your own time zone.</i>";
};

/** Full /mint (and plain-link) reply. Info only: minting happens in the dashboard / Mini App. */
export function formatDropSummary(t: ResolvedTarget, timeZone: string | null, now = Date.now()): string {
  const lines = [...dropHeader(t)];
  for (const s of displayStages(t.stages)) lines.push(...stageBlock(s, t.chain.nativeSymbol, timeZone, now));
  if (!t.stages.length) lines.push("", "No mint stages found yet.");
  if (t.warnings.length) lines.push("", ...t.warnings.map((w) => `⚠️ ${esc(w)}`));
  lines.push("", tzNote(timeZone));
  return lines.join("\n");
}
