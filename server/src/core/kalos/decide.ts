// SPDX-License-Identifier: AGPL-3.0-only
import type { KalosAllowStage, KalosDrop, KalosEligibility, KalosEntry, KalosWindow } from "./types.js";

export type StageClock = "upcoming" | "active" | "ended";

/** Open/closed comes from the drop object. Eligibility mintParams can be stale. */
export function stageClock(start: number, end: number, nowSec: number): StageClock {
  if (nowSec < start) return "upcoming";
  if (nowSec >= end) return "ended";
  return "active";
}

/** Shared counter: one minted total across every stage. balanceOf is not the cap. */
export function wantOf(cap: number, minted: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, cap - Math.max(0, minted));
}

export interface StageDecision {
  name: string;
  index: number | null;
  kind: "allowlist" | "public";
  clock: StageClock;
  priceWei: string;
  cap: number;
  want: number;
  eligible: boolean;
  reason: string | null;
  entry: KalosEntry | null;
}

function entryFor(elig: KalosEligibility | null, stage: KalosAllowStage): KalosEntry | null {
  const hits = (elig?.entries ?? []).filter((e) => e.stageIndex === stage.index || (e.stageName ?? "").trim() === stage.name.trim());
  return hits[0] ?? null;
}

/**
 * One stage for one wallet. `minted` is getMintStats.minterNumMinted (shared).
 * Balance is optional; when omitted the HYPE check is skipped (calldata tests).
 */
export function decideStage(opts: {
  name: string;
  index: number | null;
  kind: "allowlist" | "public";
  window: KalosWindow;
  minted: number;
  elig: KalosEligibility | null;
  nowSec: number;
  balanceWei?: bigint;
  gasWei?: bigint;
}): StageDecision {
  const clock = stageClock(opts.window.start, opts.window.end, opts.nowSec);
  const cap = opts.window.maxPerWallet;
  const want = wantOf(cap, opts.minted);
  const entry = opts.kind === "allowlist" ? entryFor(opts.elig, { ...opts.window, index: opts.index ?? -1, name: opts.name }) : null;
  const priceWei = opts.window.priceWei || "0";
  const base = { name: opts.name, index: opts.index, kind: opts.kind, clock, priceWei, cap, want, entry };
  if (clock === "ended") return { ...base, eligible: false, reason: "stage closed" };
  if (opts.kind === "allowlist" && !entry) return { ...base, eligible: false, reason: "not on list" };
  if (opts.kind === "allowlist" && !entry?.proof?.length) return { ...base, eligible: false, reason: "no proof" };
  if (want <= 0) return { ...base, eligible: false, reason: "cap reached" };
  if (opts.balanceWei !== undefined) {
    const price = BigInt(priceWei || "0");
    const need = price * BigInt(want) + (opts.gasWei ?? 0n);
    if (opts.balanceWei < need) return { ...base, eligible: true, reason: "insufficient balance" };
  }
  return { ...base, eligible: true, reason: clock === "upcoming" ? null : null };
}

export function decideDrop(opts: {
  drop: KalosDrop;
  elig: KalosEligibility | null;
  minted: number;
  nowSec: number;
  balanceWei?: bigint;
  gasWei?: bigint;
}): StageDecision[] {
  const common = {
    minted: opts.minted,
    elig: opts.elig,
    nowSec: opts.nowSec,
    balanceWei: opts.balanceWei,
    gasWei: opts.gasWei,
  };
  const out: StageDecision[] = [];
  for (const s of opts.drop.stages ?? []) {
    out.push(decideStage({ ...common, name: s.name.trim(), index: s.index, kind: "allowlist", window: s }));
  }
  if (opts.drop.public) {
    out.push(decideStage({ ...common, name: "Public", index: null, kind: "public", window: opts.drop.public }));
  }
  return out;
}
