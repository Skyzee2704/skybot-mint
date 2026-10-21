// SPDX-License-Identifier: AGPL-3.0-only
/** Chronological stage order: live first, then upcoming by start (soonest first), then unknown, then ended. */
const RANK: Record<string, number> = { active: 0, upcoming: 1, unknown: 2, ended: 3 };

export function sortStages<T extends { status?: string | null; start?: string | null }>(stages: readonly T[]): T[] {
  const t = (s: T) => {
    const v = s.start ? Date.parse(s.start) : NaN;
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  };
  return stages
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (RANK[a.s.status ?? "unknown"] ?? 2) - (RANK[b.s.status ?? "unknown"] ?? 2) || t(a.s) - t(b.s) || a.i - b.i)
    .map((x) => x.s);
}
