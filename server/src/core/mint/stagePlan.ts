// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server side of the Timing step: turn the member's chosen stage into the exact run time, wallets and quantities.
 * The client never decides the run time for a stage; it is always the stage start (or now while it is live).
 */
import type { Stage } from "../resolver/resolver.js";
import { MintBuildError } from "./build.js";
import { isPublicStage, timingOptions, type RowLike, type TimingOption, type WalletStageVerdict } from "./stageEligibility.js";
import type { MintRequest } from "./types.js";

export interface StageSkip {
  walletId: string;
  reason: string;
}
export interface StageChoice {
  req: MintRequest;
  option: TimingOption<Stage>;
  skipped: StageSkip[];
  /** Wallets whose quantity was lowered to the stage's per-wallet limit. */
  capped: { walletId: string; quantity: number }[];
}

const skipReason = (stage: string, v: WalletStageVerdict) =>
  v.state === "not_eligible"
    ? `Not eligible for ${stage}. Skipped.`
    : v.state === "unverified"
      ? `Not verified with OpenSea for ${stage}. Skipped.`
      : `Eligibility for ${stage} unknown. Run Check Eligibility again. Skipped.`;

export function applyStageChoice(stages: readonly Stage[], rows: readonly RowLike[], req: MintRequest, now = Date.now()): StageChoice {
  const name = req.stage!;
  const ids = req.wallets.map((w) => w.walletId);
  const option = timingOptions(stages, rows, ids, null, now).find((o) => o.kind === "stage" && o.key === name);
  if (!option?.stage) {
    const s = stages.find((x) => x.name === name);
    throw new MintBuildError(
      !s
        ? `Stage "${name}" is not part of this drop. Resolve the collection again.`
        : `None of the selected wallets can mint in ${name} (stage ended or no eligible wallet). Check eligibility again.`,
      "STAGE",
    );
  }
  const stage = option.stage;
  if (req.strategy === "seadrop_public" && !isPublicStage(stage))
    throw new MintBuildError(`${stage.name} is an allowlist stage. Use the OpenSea mint method for it.`, "STAGE");
  if (req.strategy === "generic") throw new MintBuildError("Stage scheduling is not available for plain contract mints.", "STAGE");

  const use = new Set(option.walletIds);
  const skipped = option.skipped.map((v) => ({ walletId: v.walletId, reason: skipReason(option.name, v) }));
  const capped: StageChoice["capped"] = [];
  const wallets = req.wallets
    .filter((w) => use.has(w.walletId))
    .map((w) => {
      const r = rows.find((x) => x.walletId === w.walletId);
      const v = r?.stages?.find((x) => (x.label ?? "").trim().toLowerCase() === stage.name.trim().toLowerCase());
      const cap = (isPublicStage(stage) ? null : v?.maxPerWallet) ?? stage.maxPerWallet ?? null;
      if (cap && w.quantity > cap) {
        capped.push({ walletId: w.walletId, quantity: cap });
        return { ...w, quantity: cap };
      }
      return w;
    });
  return {
    option,
    skipped,
    capped,
    req: { ...req, wallets, runAt: option.runAt, offsetMs: option.live ? 0 : (req.offsetMs ?? 0) },
  };
}
