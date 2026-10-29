// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mapStageVerdicts, sameStage, stageKey } from "../src/core/mint/eligibility.js";
import { groupByStage, summarizeGroup } from "../src/core/mint/stageEligibility.js";

// Real shapes from production (thesquad-nfts, 2026-10-22): the drops API returns bare-hex stage ids,
// the eligibility API returns dashed UUIDs for the same stages.
const dropStages = [
  {
    uuid: "03b94a9088894e9986c0fa32bed45bbe",
    stage_type: "public_sale",
    label: "Public stage",
    start_time: "2026-10-22T16:00:00Z",
    price: "3000000000000000",
  },
  {
    uuid: "f7768398416f49dead4798ad09c31bc9",
    stage_type: "signed_presale",
    label: "GTD",
    start_time: "2026-10-22T14:00:00Z",
    price: "3000000000000000",
  },
  {
    uuid: "cc267f20a2ec4b43b698b73597a838b7",
    stage_type: "signed_presale",
    label: "FCFS",
    start_time: "2026-10-22T15:00:00Z",
    price: "3000000000000000",
  },
] as any[];
const verdicts = [
  { stage_uuid: "f7768398-416f-49de-ad47-98ad09c31bc9", is_eligible: false, price: null, max_total_mintable_by_wallet: null },
  { stage_uuid: "cc267f20-a2ec-4b43-b698-b73597a838b7", is_eligible: true, price: null, max_total_mintable_by_wallet: "2" },
  { stage_uuid: "03b94a90-8889-4e99-86c0-fa32bed45bbe", is_eligible: true, price: "3000000000000000", max_total_mintable_by_wallet: "3" },
];

describe("OpenSea stage id matching", () => {
  it("treats dashed and bare-hex ids of the same stage as equal", () => {
    expect(sameStage("f7768398-416f-49de-ad47-98ad09c31bc9", "f7768398416f49dead4798ad09c31bc9")).toBe(true);
    expect(sameStage("F7768398-416F-49DE-AD47-98AD09C31BC9", "f7768398416f49dead4798ad09c31bc9")).toBe(true);
    expect(sameStage("f7768398416f49dead4798ad09c31bc9", "cc267f20a2ec4b43b698b73597a838b7")).toBe(false);
    expect(sameStage(null, null)).toBe(false);
    expect(sameStage(undefined, "")).toBe(false);
    expect(stageKey("")).toBeNull();
  });

  it("maps every eligibility verdict onto the drop's stages (regression: all wallets showed Unknown)", () => {
    const stages = mapStageVerdicts(dropStages, verdicts);
    const by = Object.fromEntries(stages.map((s) => [s.label, s]));
    expect(by["GTD"].eligible).toBe(false);
    expect(by["FCFS"].eligible).toBe(true);
    expect(by["FCFS"].maxPerWallet).toBe(2);
    expect(by["Public stage"].eligible).toBe(true);
    expect(stages.every((s) => s.eligible !== null)).toBe(true);
  });

  it("feeds real Eligible / Not eligible per phase to the web page and /check grouping", () => {
    const row = {
      walletId: "w1",
      label: "wallet-1",
      address: "0x540D000000000000000000000000000000000000",
      access: { status: "no" },
      reasons: [],
      stages: mapStageVerdicts(dropStages, verdicts),
    };
    const t = dropStages.map((s) => ({ name: s.label, type: /public/.test(s.stage_type) ? "public" : "allowlist", start: s.start_time }));
    const groups = groupByStage(t, [row], { label: "GTD", type: "signed_presale" });
    const gtd = summarizeGroup(groups.find((g) => g.stage.name === "GTD")!);
    const fcfs = summarizeGroup(groups.find((g) => g.stage.name === "FCFS")!);
    expect(gtd.notEligible).toHaveLength(1);
    expect(fcfs.eligible).toHaveLength(1);
    expect(gtd.unknown.length + fcfs.unknown.length).toBe(0);
  });
});
