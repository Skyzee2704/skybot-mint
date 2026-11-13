// SPDX-License-Identifier: AGPL-3.0-only
// The Mint table used to render the checker's target stage (live, else the soonest — here Team Mint,
// max 699, nobody allowlisted) while the stage list used per-stage verdicts. With nothing preselected,
// the Timing picker only offered Public. The chosen stage is the one source of truth.
import { describe, expect, it } from "vitest";
import { applyStageChoice } from "../src/core/mint/stagePlan.js";
import { groupByStage, mintStageOptions, pickTimingOption, stageWalletView, timingOptions } from "../src/core/mint/stageEligibility.js";

// SkyBOT-shaped drop: Team (02:00 UTC+8) → GTD (03:00) → FCFS (06:30) → Public (08:30), 10 Nov 2026.
const drop: any[] = [
  {
    name: "Team Mint",
    type: "signed",
    priceWei: "0",
    start: "2026-11-09T18:00:00.000Z",
    end: "2026-11-09T19:00:00.000Z",
    maxPerWallet: 699,
    status: "upcoming",
  },
  {
    name: "GTD list",
    type: "signed",
    priceWei: "0",
    start: "2026-11-09T19:00:00.000Z",
    end: "2026-11-09T22:30:00.000Z",
    maxPerWallet: 1,
    status: "upcoming",
  },
  {
    name: "FCFS list",
    type: "signed",
    priceWei: "0",
    start: "2026-11-09T22:30:00.000Z",
    end: "2026-11-10T00:30:00.000Z",
    maxPerWallet: 1,
    status: "upcoming",
  },
  {
    name: "Public",
    type: "public",
    priceWei: "1000000000000000",
    start: "2026-11-10T00:30:00.000Z",
    end: "2026-11-11T00:30:00.000Z",
    maxPerWallet: 5,
    status: "upcoming",
  },
];
const target = { label: "Team Mint", type: "signed" };
const before = Date.parse("2026-11-09T12:00:00.000Z");
const v = (label: string, eligible: boolean, max: number | null) => ({ label, type: "signed", eligible, maxPerWallet: max });
// Row-level fields are Team's (the bug): not eligible, max 699. Per-stage verdicts disagree.
const row = (id: string, label: string, stages: any[]) => ({
  walletId: id,
  label,
  address: "0x" + id.padStart(40, "a"),
  access: { status: "no", source: "OpenSea eligibility API" },
  reasons: ["not allowlisted (OpenSea eligibility API)"],
  maxQty: 699,
  suggestedQty: 699,
  unitPriceWei: "0",
  mintedSoFar: 0,
  stages,
});
const rows = [
  row("1", "wallet-1", [v("Team Mint", false, 699), v("GTD list", false, 1), v("FCFS list", false, 1)]),
  row("2", "wallet-2", [v("Team Mint", false, 699), v("GTD list", true, 1), v("FCFS list", true, 1)]),
  row("3", "Wallet 3", [v("Team Mint", false, 699), v("GTD list", true, 1), v("FCFS list", false, 1)]),
  row("4", "wallet-4", [v("Team Mint", false, 699), v("GTD list", true, 1), v("FCFS list", true, 1)]),
  row("5", "wallet-5", [v("Team Mint", false, 699), v("GTD list", false, 1), v("FCFS list", true, 1)]),
];

describe("mint stage selection", () => {
  it("offers every stage some wallet can mint, soonest first, and defaults to that stage", () => {
    const opts = mintStageOptions(drop, rows, target, before);
    expect(opts.map((o) => o.name)).toEqual(["GTD list", "FCFS list", "Public"]);
    expect(opts.map((o) => o.key)).not.toContain("Team Mint");
    const chosen = pickTimingOption(opts, null);
    expect(chosen.fellBack).toBe(false);
    expect(chosen.option?.name).toBe("GTD list");
    expect(chosen.option?.runAt).toBe("2026-11-09T19:00:00.000Z");
    expect(chosen.option?.walletIds).toEqual(["2", "3", "4"]);
  });

  it("an empty checkbox selection used to hide allowlist stages and leave only Public", () => {
    // The old Mint page passed the preselected ids. Team had nobody eligible, so the set was empty.
    expect(timingOptions(drop, rows, [], target, before).map((o) => o.name)).toEqual(["Public"]);
  });

  it("the wallet table for the chosen stage matches that stage, not the first stage", () => {
    const gtd = drop[1];
    const views = rows.map((r) => stageWalletView(r, gtd, target));
    expect(views.map((w) => w.eligible)).toEqual([false, true, true, true, false]);
    expect(views.every((w) => w.maxQty === 1 && w.suggestedQty === 1)).toBe(true);
    expect(views.filter((w) => w.eligible).every((w) => w.reason === null && w.access === "yes")).toBe(true);
    expect(
      views.filter((w) => !w.eligible).every((w) => w.reason === "not allowlisted (OpenSea eligibility API)" && w.access === "no"),
    ).toBe(true);
    // Same wallets the stage list counts.
    const group = groupByStage(drop, rows, target).find((g) => g.stage.name === "GTD list")!;
    expect(group.wallets.filter((w) => w.state === "eligible").map((w) => w.walletId)).toEqual(
      views.filter((w) => w.eligible).map((w) => w.walletId),
    );
    // Team, if it were the selected stage, still shows its own cap — not GTD's.
    const team = rows.map((r) => stageWalletView(r, drop[0], target));
    expect(team.every((w) => !w.eligible && w.maxQty === 699 && w.suggestedQty === 699)).toBe(true);
  });

  it("picking FCFS changes who is eligible and keeps that stage's max", () => {
    const fcfs = mintStageOptions(drop, rows, target, before).find((o) => o.name === "FCFS list")!;
    const views = rows.map((r) => stageWalletView(r, fcfs.stage, target));
    expect(views.filter((w) => w.eligible).map((w) => w.walletId)).toEqual(fcfs.walletIds);
    expect(views.every((w) => w.maxQty === 1)).toBe(true);
    expect(fcfs.walletIds).toEqual(["2", "4", "5"]);
  });

  it("Public uses the public price and max, and every wallet", () => {
    const pub = mintStageOptions(drop, rows, target, before).find((o) => o.name === "Public")!;
    const views = rows.map((r) => stageWalletView(r, pub.stage, target));
    expect(views.every((w) => w.eligible && w.access === "public" && w.maxQty === 5 && w.reason === null)).toBe(true);
    expect(views[0].unitPriceWei).toBe("1000000000000000");
    expect(pub.walletIds).toEqual(rows.map((r) => r.walletId));
  });

  it("already-minted count lowers the chosen stage's cap", () => {
    const view = stageWalletView({ ...rows[1], mintedSoFar: 1 }, drop[3], target);
    expect(view.maxQty).toBe(4);
    expect(view.suggestedQty).toBe(4);
  });

  it("a scheduled GTD mint fires at GTD start with GTD's limit, not Team's 699", () => {
    const req: any = {
      chain: "ethereum",
      contract: "0x1",
      strategy: "opensea_api",
      stage: "GTD list",
      runAt: "2030-01-01T00:00:00.000Z",
      offsetMs: -150,
      wallets: rows.map((r) => ({ walletId: r.walletId, quantity: 699 })),
    };
    const c = applyStageChoice(drop, rows, req, before);
    expect(c.req.runAt).toBe("2026-11-09T19:00:00.000Z");
    expect(c.req.offsetMs).toBe(-150);
    expect(c.req.wallets.map((w) => w.walletId)).toEqual(["2", "3", "4"]);
    expect(c.req.wallets.every((w) => w.quantity === 1)).toBe(true);
    expect(c.skipped.map((s) => s.walletId).sort()).toEqual(["1", "5"]);
  });

  it("the mint API verdict wins for the live stage when the per-stage verdict disagrees", () => {
    // Regression: a wallet the mint API rejected for the live Team stage was offered a
    // Team job because the eligibility API's per-stage verdict said eligible. The mint
    // API actually built (or refused) the tx, so it is the ground truth for that stage.
    const team = drop[0];
    const disagree = {
      ...row("9", "wallet-9", [v("Team Mint", true, 699), v("GTD list", false, 1), v("FCFS list", false, 1)]),
      access: { status: "no", source: "OpenSea mint API" },
      reasons: ["not allowlisted (OpenSea mint API)"],
    };
    expect(stageWalletView(disagree, team, target).eligible).toBe(false);
    expect(stageWalletView(disagree, team, target).access).toBe("no");
    // Nobody can mint Team, so it is not offered at all — only GTD, FCFS, Public.
    const opts = mintStageOptions(drop, [disagree], target, before);
    expect(opts.map((o) => o.name)).toEqual(["Public"]);
    expect(opts.map((o) => o.key)).not.toContain("Team Mint");
    // And the reverse: the mint API accepting the wallet beats a "not eligible" per-stage verdict.
    const accepted = {
      ...row("8", "wallet-8", [v("Team Mint", false, 699), v("GTD list", false, 1), v("FCFS list", false, 1)]),
      access: { status: "yes", source: "OpenSea mint API" },
      reasons: [],
    };
    expect(stageWalletView(accepted, team, target).eligible).toBe(true);
    expect(mintStageOptions(drop, [accepted], target, before).map((o) => o.name)).toContain("Team Mint");
  });
});
