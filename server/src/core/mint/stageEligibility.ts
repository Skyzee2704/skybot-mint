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
