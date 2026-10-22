// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-stage wallet eligibility (shared by Telegram /check and the web Mint page). Pure: no I/O.
 * Public stages are open to every wallet, so only allowlist-type stages get per-wallet lists.
 */
import { sortStages } from "../resolver/stageOrder.js";

export interface StageLike {
  name: string;
  type?: string | null;
  start?: string | null;
  end?: string | null;
  status?: string | null;
  maxPerWallet?: number | null;
  priceWei?: string | null;
}

export interface RowLike {
  walletId: string;
  label: string;
  address: string;
  needsOpenSeaLogin?: boolean;
  access?: { status: string; detail?: string } | null;
  reasons?: string[];
  stages?: { label: string | null; type: string | null; eligible: boolean | null; maxPerWallet: number | null }[] | null;
}

export type StageState = "eligible" | "not_eligible" | "unverified" | "unknown";

export interface WalletStageVerdict {
  walletId: string;
  label: string;
  address: string;
  state: StageState;
  max: number | null;
  /** Extra blocker for this stage (e.g. wallet limit reached, sold out). */
  note: string | null;
}

export interface StageGroup<S extends StageLike = StageLike> {
  stage: S;
  wallets: WalletStageVerdict[];
  eligible: number;
  total: number;
}

export const isPublicStage = (s: StageLike) => s.type === "public" || /\bpublic\b/i.test(s.name);

const norm = (x: string | null | undefined) => (x ?? "").trim().toLowerCase();

/** Wallet verdict for one stage, from the OpenSea per-stage result or, for the stage being checked, the access result. */
export function walletStageVerdict(
  r: RowLike,
  stage: StageLike,
  targetStage: { label: string | null; type?: string | null } | null,
): WalletStageVerdict {
  const base = { walletId: r.walletId, label: r.label, address: r.address };
  const sv = r.stages?.find((x) => norm(x.label) === norm(stage.name) || (!x.label && norm(x.type) === norm(stage.name)));
  const isTarget = Boolean(targetStage && (norm(targetStage.label) === norm(stage.name) || norm(targetStage.type) === norm(stage.name)));
  const blockers = isTarget ? (r.reasons ?? []).filter((x) => !/^insufficient balance|^not allowlisted|^simulation reverts/i.test(x)) : [];
  const note = blockers[0] ?? null;
  if (sv && sv.eligible !== null)
    return {
      ...base,
      state: sv.eligible ? "eligible" : "not_eligible",
      max: sv.maxPerWallet ?? stage.maxPerWallet ?? null,
      note: sv.eligible ? note : null,
    };
  if (isTarget && r.access && (r.access.status === "yes" || r.access.status === "no"))
    return {
      ...base,
      state: r.access.status === "yes" ? "eligible" : "not_eligible",
      max: stage.maxPerWallet ?? null,
      note: r.access.status === "yes" ? note : null,
    };
  return { ...base, state: r.needsOpenSeaLogin ? "unverified" : "unknown", max: null, note: null };
}

/** Allowlist stages that are live, upcoming or undated (ended and public stages skipped), soonest first. */
export function groupByStage<S extends StageLike>(
  stages: readonly S[],
  rows: readonly RowLike[],
  targetStage: { label: string | null; type?: string | null } | null,
): StageGroup<S>[] {
  return sortStages(stages)
    .filter((s) => !isPublicStage(s) && s.status !== "ended")
    .map((stage) => {
      const wallets = rows.map((r) => walletStageVerdict(r, stage, targetStage));
      return { stage, wallets, eligible: wallets.filter((w) => w.state === "eligible").length, total: wallets.length };
    });
}

export function verdictText(v: WalletStageVerdict): string {
  if (v.state === "eligible") return `eligible${v.max ? ` (max ${v.max})` : ""}${v.note ? ` · ${v.note}` : ""}`;
  if (v.state === "not_eligible") return "not eligible";
  if (v.state === "unverified") return "not verified yet";
  return "unknown";
}

export interface GroupSummary {
  eligible: WalletStageVerdict[];
  notEligible: WalletStageVerdict[];
  unknown: WalletStageVerdict[];
}

/** Split a phase's verdicts into eligible / not eligible / unknown (unverified counts as unknown). */
export function summarizeGroup(g: StageGroup): GroupSummary {
  return {
    eligible: g.wallets.filter((w) => w.state === "eligible"),
    notEligible: g.wallets.filter((w) => w.state === "not_eligible"),
    unknown: g.wallets.filter((w) => w.state === "unverified" || w.state === "unknown"),
  };
}

/** Names inline only for short lists, so 20+ wallets stay one line. */
export function nameList(ws: { label: string }[], max = 3): string {
  return ws.length && ws.length <= max ? `: ${ws.map((w) => w.label).join(", ")}` : "";
}

/* ---------- Mint timing options (web + Mini App "Timing" step; the server re-derives the same plan) ---------- */

const ms = (iso: string | null | undefined) => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
};

/** Live at `now`: started and not yet ended. Undated stages fall back to their resolved status. */
export function stageLiveAt(s: StageLike, now: number): boolean {
  const start = ms(s.start);
  const end = ms(s.end);
  if (start === null) return s.status === "active" && (end === null || now < end);
  return start <= now && (end === null || now < end);
}

/** Over at `now` (past its end time, or resolved as ended without dates). */
export function stageEndedAt(s: StageLike, now: number): boolean {
  const end = ms(s.end);
  if (end !== null) return now >= end;
  return s.status === "ended";
}

/** A stage with a known start, or one that is live: something a mint can be scheduled into. */
const schedulable = (s: StageLike, now: number) => ms(s.start) !== null || stageLiveAt(s, now);

export interface TimingOption<S extends StageLike = StageLike> {
  /** "now", or the stage name (unique per drop). */
  key: string;
  kind: "now" | "stage";
  /** Stage the mint runs in; null only for drops without stage data (generic contracts), where "Now" is the only choice. */
  stage: S | null;
  /** Display name: the stage name, or "Public" for the public stage. */
  name: string;
  live: boolean;
  /** Broadcast time: null = immediately (stage is live), else the stage start. */
  runAt: string | null;
  /** Selected wallets that mint in this option. */
  walletIds: string[];
  /** Selected wallets left out (not eligible / not verified for this stage). */
  skipped: WalletStageVerdict[];
}

/**
 * Timing choices for the selected wallets, soonest first:
 *  - one option per upcoming or live allowlist stage at least one selected wallet is eligible for;
 *  - the public stage (always, if the drop has one that hasn't ended), labelled "Public", using every selected wallet;
 *  - "Now" first, only while one of those stages is live, minting within that live stage.
 * Ended stages are hidden. Drops without dated stages (e.g. plain contracts) offer only "Now".
 */
export function timingOptions<S extends StageLike>(
  stages: readonly S[],
  rows: readonly RowLike[],
  selectedIds: readonly string[],
  targetStage: { label: string | null; type?: string | null } | null,
  now: number,
): TimingOption<S>[] {
  const sel = new Set(selectedIds);
  const selRows = rows.filter((r) => sel.has(r.walletId));
  const allIds = selRows.map((r) => r.walletId);
  const open = stages.filter((s) => !stageEndedAt(s, now) && schedulable(s, now));
  if (!stages.some((s) => schedulable(s, now) || stageEndedAt(s, now)))
    return [{ key: "now", kind: "now", stage: null, name: "Now", live: true, runAt: null, walletIds: allIds, skipped: [] }];
  const opts: TimingOption<S>[] = [];
  for (const s of open) {
    const live = stageLiveAt(s, now);
    const runAt = live ? null : (s.start ?? null);
    if (isPublicStage(s)) {
      opts.push({ key: s.name, kind: "stage", stage: s, name: "Public", live, runAt, walletIds: allIds, skipped: [] });
      continue;
    }
    const verdicts = selRows.map((r) => walletStageVerdict(r, s, targetStage));
    const ok = verdicts.filter((v) => v.state === "eligible");
    if (!ok.length) continue;
    opts.push({
      key: s.name,
      kind: "stage",
      stage: s,
      name: s.name,
      live,
      runAt,
      walletIds: ok.map((v) => v.walletId),
      skipped: verdicts.filter((v) => v.state !== "eligible"),
    });
  }
  opts.sort((a, b) => (a.live === b.live ? (ms(a.runAt) ?? 0) - (ms(b.runAt) ?? 0) : a.live ? -1 : 1));
  const liveOpt = opts.find((o) => o.live);
  if (liveOpt) opts.unshift({ ...liveOpt, key: "now", kind: "now" });
  return opts;
}

/** Keep the member's choice while it is still offered; if it disappears fall back to Public (then the first option). */
export function pickTimingOption<S extends StageLike>(
  opts: readonly TimingOption<S>[],
  wanted: string | null,
): { option: TimingOption<S> | null; fellBack: boolean } {
  if (!wanted) return { option: opts[0] ?? null, fellBack: false }; // default: Now while live, else the soonest stage
  const hit = opts.find((o) => o.key === wanted);
  if (hit) return { option: hit, fellBack: false };
  const pub = opts.find((o) => o.kind === "stage" && o.stage && isPublicStage(o.stage));
  const option = pub ?? opts[0] ?? null;
  return { option, fellBack: Boolean(option) };
}
