// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared stage verdicts for the OpenSea mint path — the ONE place that decides what an
 * OpenSea 422 (or a 200 built for the wrong stage) means. executor.ts (live mint) and
 * simulate.ts (pre-flight simulation) both use these helpers, so the two paths cannot
 * drift apart.
 *
 * What is unified here is ONLY the classification/build decision. Timing is deliberately
 * NOT unified: a scheduled job still probes from T0−150ms (fireAt + probeAndRelease) and
 * Mint Now still executes immediately when clicked, with no scheduling, no queue and no
 * probe-wait. Forcing Mint Now through the scheduled path would be wrong.
 */

/** Stage names compare case-insensitively (A2): "Team Round", "team round" and " Team Round " are one stage. */
export function sameStageName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * Stage name OpenSea names in a 422 "not eligible for the active drop stage" message,
 * e.g. 'Team Round' in "Wallet is not eligible for the active drop stage, 'Team Round'
 * (signed_presale)". Undefined when the message names no stage.
 *
 * A1: the name is closed by the quote that precedes " (type)", so an apostrophe inside
 * the name ("Collector's Round") does not cut it short.
 * A3: the comma after "stage" is optional — "...active drop stage 'Team Round'
 * (signed_presale)" parses the same as the comma variant.
 */
export function parseOpenSeaActiveStage(message: string): string | undefined {
  const withType = /active drop stage,?\s*['"](.+?)['"]\s*\(/i.exec(message);
  if (withType?.[1]) return withType[1];
  const bare = /active drop stage,?\s*['"]([^'"]+)['"]/i.exec(message);
  return bare?.[1];
}

/**
 * Verdict for an OpenSea 422 NOT_ELIGIBLE from the mint API.
 *
 * The probe's first call lands at T0−150ms, while the previous stage is still active, so a
 * 422 there says nothing about the chosen stage: the wallet may be perfectly eligible for
 * the stage that opens at T0. Such a 422 is "closed" (retried like a 409 past T0) unless it
 * arrives after the chosen stage's start AND names the chosen stage itself — only then is
 * it a final "live" verdict.
 *
 * A4: when the message names no stage there is nothing to compare ("unknown stage"). That
 * proves nothing about the chosen stage — a delayed stage opening (clock skew, OpenSea
 * lag) is plausible — so it is retried while the build budget is open and only becomes
 * final "live" once the budget is spent, so the job still ends instead of hanging. (The
 * probe stops calling at the deadline and fails the wallet then, so "live" past the
 * deadline is the verdict the next classify call would give.) Callers without a build
 * deadline keep the round-1 behavior: an unnamed stage after T0 is final.
 */
export function classifyNotEligible(opts: {
  message: string;
  /** Start of the chosen stage (T0). Undefined for a mint-now job: the stage is already live. */
  fireAt?: number;
  chosenStage?: string | null;
  now?: number;
  /** End of the build budget; an unnamed-stage 422 retries until this instant. */
  buildDeadline?: number;
}): "closed" | "live" {
  const now = opts.now ?? Date.now();
  if (opts.fireAt === undefined) return "live";
  if (now < opts.fireAt) return "closed";
  const active = parseOpenSeaActiveStage(opts.message);
  if (active !== undefined) {
    if (opts.chosenStage == null) return "live";
    return sameStageName(active, opts.chosenStage) ? "live" : "closed";
  }
  if (opts.chosenStage != null && opts.buildDeadline !== undefined && now < opts.buildDeadline) return "closed";
  return "live";
}

/** Stage the mint API says a 200 was built for (official docs: the stage whose window contains now). */
export interface MintStageId {
  uuid?: string;
  startTime?: string;
  stageType?: string;
}

/** Undefined when the 200 response names no stage at all. */
export function mintStageOf(r: { stage_uuid?: string; stage_type?: string; stage_start_time?: string }): MintStageId | undefined {
  if (!r.stage_uuid && !r.stage_start_time) return undefined;
  return { uuid: r.stage_uuid, startTime: r.stage_start_time, stageType: r.stage_type };
}

/**
 * Is the stage the mint API built for the chosen stage? true = same, false = a different
 * stage, undefined = the data cannot tell (no uuid on either side and no comparable start
 * time). A uuid match wins; otherwise the stage start instants are compared.
 */
export function matchesChosenStage(chosen: { uuid?: string; start: string | null }, got: MintStageId): boolean | undefined {
  if (got.uuid !== undefined && chosen.uuid !== undefined) return got.uuid.toLowerCase() === chosen.uuid.toLowerCase();
  if (got.startTime !== undefined && chosen.start !== null) {
    const a = Date.parse(got.startTime);
    const b = Date.parse(chosen.start);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return undefined;
}
