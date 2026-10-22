// SPDX-License-Identifier: AGPL-3.0-only
// Votaries (Ethereum, 2026-10-22): Team live (mint API: not eligible) + Whitelist upcoming. Before the fix the
// eligibility API was skipped once the mint API decided the live stage, so every Whitelist verdict was "unknown".
import { describe, expect, it } from "vitest";
import { mapStageVerdicts, otherOpenAllowlistStages, upcomingStage, wantsEligibilityApi } from "../src/core/mint/eligibility.js";
import { groupByStage } from "../src/core/mint/stageEligibility.js";
import { headCount } from "../src/bot/check.js";

// Real drop stages and eligibility response (ids as OpenSea returned them: public without dashes in the drop).
const stages: any[] = [
  {
    uuid: "33aecc063a134e78bd80c4c9910bb920",
    stage_type: "public_sale",
    label: "Public",
    start_time: "2026-10-22T22:10:00Z",
    end_time: "2026-10-25T22:10:00Z",
    max_per_wallet: "1",
    price: "1000000000000000",
  },
  {
    uuid: "400ebb1e-73a3-46af-a275-2fa45e71b44f",
    stage_type: "signed_presale",
    label: "Team",
    start_time: "2026-10-22T16:00:00Z",
    end_time: "2026-10-22T16:10:00Z",
    max_per_wallet: "30",
    price: "0",
  },
  {
    uuid: "f550cb7b-04ba-4841-a2f5-f8a7cb8602e8",
    stage_type: "signed_presale",
    label: "Whitelist",
    start_time: "2026-10-22T16:10:00Z",
    end_time: "2026-10-22T22:10:00Z",
    max_per_wallet: "1",
    price: "0",
  },
];
const response = [
  { stage_uuid: "400ebb1e-73a3-46af-a275-2fa45e71b44f", is_eligible: false, price: null, max_total_mintable_by_wallet: null },
  { stage_uuid: "f550cb7b-04ba-4841-a2f5-f8a7cb8602e8", is_eligible: false, price: null, max_total_mintable_by_wallet: null },
  { stage_uuid: "33aecc06-3a13-4e78-bd80-c4c9910bb920", is_eligible: true, price: "1000000000000000", max_total_mintable_by_wallet: "1" },
];
const at1604 = Date.parse("2026-10-22T16:04:00Z");
const team = stages[1];

describe("allowlist stages beyond the live one", () => {
  it("Team live and decided: Whitelist is still open, so the eligibility API runs", () => {
    const others = otherOpenAllowlistStages(stages, team, at1604);
    expect(others.map((s) => s.label)).toEqual(["Whitelist"]);
    expect(wantsEligibilityApi(true, others)).toBe(true);
    expect(wantsEligibilityApi(false, [])).toBe(true);
    // Only a decided live stage with no other open allowlist stage skips it (unchanged behaviour).
    expect(wantsEligibilityApi(true, otherOpenAllowlistStages(stages, stages[2], Date.parse("2026-10-22T16:30:00Z")))).toBe(false);
  });

  it("OpenSea's next_stage null: the soonest later stage is used", () => {
    expect(upcomingStage(stages, team, at1604)?.label).toBe("Whitelist");
    expect(upcomingStage(stages, null, Date.parse("2026-10-22T15:00:00Z"))?.label).toBe("Team");
    expect(upcomingStage(stages, null, Date.parse("2026-10-26T00:00:00Z"))).toBeNull();
  });

  it("every allowlist stage resolves from the real response (Whitelist: not eligible, not unknown)", () => {
    const sv = mapStageVerdicts(stages, response);
    const rows = Array.from({ length: 8 }, (_, i) => ({
      walletId: `w${i}`,
      label: `wallet-${i + 1}`,
      address: `0x${String(i).padStart(40, "0")}`,
      needsOpenSeaLogin: false,
      access: { status: "no" },
      reasons: [],
      stages: sv.map((s) => ({ label: s.label, type: s.type, eligible: s.eligible, maxPerWallet: s.maxPerWallet })),
    }));
    const ui = stages.map((s) => ({
      name: s.label,
      type: /public/.test(s.stage_type) ? "public" : "signed",
      start: s.start_time,
      end: s.end_time,
    }));
    const groups = groupByStage(ui, rows, { label: "Team" });
    expect(groups.map((g) => [g.stage.name, g.wallets.map((w) => w.state)])).toEqual([
      ["Team", Array(8).fill("not_eligible")],
      ["Whitelist", Array(8).fill("not_eligible")],
    ]);
    expect(groups.map((g) => headCount(g))).toEqual(["Team: 0/8 eligible", "Whitelist: 0/8 eligible"]);
  });

  it("headline never shows unknown wallets as 0/x eligible", () => {
    const g = (states: string[]) => ({
      stage: { name: "Whitelist" },
      wallets: states.map((state) => ({ state })),
      eligible: states.filter((s) => s === "eligible").length,
      total: states.length,
    });
    expect(headCount(g(Array(8).fill("unknown")))).toBe("Whitelist: 8 unknown");
    expect(headCount(g(["eligible", "unverified", "not_eligible"]))).toBe("Whitelist: 1/3 eligible, 1 unknown");
    expect(headCount(g(["not_eligible", "not_eligible"]))).toBe("Whitelist: 0/2 eligible");
  });
});
