// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { pickTimingOption, stageLiveAt, timingOptions } from "../src/core/mint/stageEligibility.js";
import { applyStageChoice } from "../src/core/mint/stagePlan.js";

// thesquad-nfts as resolved on 2026-10-22 (GTD 14:00Z, FCFS 15:00Z, Public 16:00Z).
const stages: any[] = [
  { name: "GTD", type: "signed", priceWei: "3000000000000000", start: "2026-10-22T14:00:00.000Z", end: "2026-10-22T15:00:00.000Z", maxPerWallet: 2, status: "upcoming", source: "opensea" },
  { name: "FCFS", type: "signed", priceWei: "3000000000000000", start: "2026-10-22T15:00:00.000Z", end: "2026-10-22T16:00:00.000Z", maxPerWallet: 2, status: "upcoming", source: "opensea" },
  { name: "Public (on-chain)", type: "public", priceWei: "3000000000000000", start: "2026-10-22T16:00:00.000Z", end: "2026-10-23T16:00:00.000Z", maxPerWallet: 3, status: "upcoming", source: "onchain" },
];
const v = (label: string, eligible: boolean | null, max: number | null = null) => ({ label, type: "signed_presale", eligible, maxPerWallet: max });
const rows: any[] = [
  { walletId: "a", label: "Main", address: "0xa", stages: [v("GTD", true, 2), v("FCFS", false), v("Public stage", true, 3)] },
  { walletId: "b", label: "wallet-2", address: "0xb", stages: [v("GTD", false), v("FCFS", false), v("Public stage", true, 3)] },
  { walletId: "c", label: "wallet-3", address: "0xc", stages: [v("GTD", false), v("FCFS", true, 1), v("Public stage", true, 3)] },
];
const at = (iso: string) => Date.parse(iso);
const keys = (o: { key: string }[]) => o.map((x) => x.key);

describe("timing options", () => {
  it("before any stage: no Now, eligible stages by start, Public last", () => {
    const o = timingOptions(stages, rows, ["a", "b", "c"], null, at("2026-10-22T09:22:00Z"));
    expect(keys(o)).toEqual(["GTD", "FCFS", "Public (on-chain)"]);
    expect(o[0].runAt).toBe("2026-10-22T14:00:00.000Z");
    expect(o[0].walletIds).toEqual(["a"]);
    expect(o[0].skipped.map((s) => s.walletId)).toEqual(["b", "c"]);
    expect(o[2].name).toBe("Public");
    expect(o[2].walletIds).toEqual(["a", "b", "c"]);
  });
  it("no allowlist eligibility: only Public (and no Now before it opens)", () => {
    const o = timingOptions(stages, rows, ["b"], null, at("2026-10-22T09:22:00Z"));
    expect(keys(o)).toEqual(["Public (on-chain)"]);
  });
  it("Now appears only while an eligible stage is live, and mints in that stage", () => {
    const o = timingOptions(stages, rows, ["a", "b"], null, at("2026-10-22T14:00:00Z"));
    expect(keys(o)).toEqual(["now", "GTD", "Public (on-chain)"]);
    expect(o[0].stage?.name).toBe("GTD");
    expect(o[0].runAt).toBeNull();
    expect(o[1].live).toBe(true);
    expect(o[0].walletIds).toEqual(["a"]);
  });
  it("a live stage nobody selected is eligible for does not produce Now", () => {
    const o = timingOptions(stages, rows, ["b"], null, at("2026-10-22T14:30:00Z"));
    expect(keys(o)).toEqual(["Public (on-chain)"]);
  });
  it("ended stages are hidden; Public live gives Now with all wallets", () => {
    const o = timingOptions(stages, rows, ["a", "b", "c"], null, at("2026-10-22T16:00:01Z"));
    expect(keys(o)).toEqual(["now", "Public (on-chain)"]);
    expect(o[0].walletIds).toEqual(["a", "b", "c"]);
  });
  it("re-evaluates on time: the same inputs flip to live at the start", () => {
    expect(stageLiveAt(stages[0], at("2026-10-22T13:59:59.999Z"))).toBe(false);
    expect(stageLiveAt(stages[0], at("2026-10-22T14:00:00Z"))).toBe(true);
    expect(stageLiveAt(stages[0], at("2026-10-22T15:00:00Z"))).toBe(false);
  });
  it("drops without dated stages offer only Now", () => {
    const g = [{ name: "Contract mint: mint(uint256)", type: "unknown", start: null, end: null, status: "unknown" }];
    const o = timingOptions(g, rows, ["a"], null, Date.now());
    expect(keys(o)).toEqual(["now"]);
    expect(o[0].stage).toBeNull();
  });
  it("default is the first option; a vanished choice falls back to Public", () => {
    const o = timingOptions(stages, rows, ["b"], null, at("2026-10-22T09:22:00Z"));
    expect(pickTimingOption(o, null)).toEqual({ option: o[0], fellBack: false });
    const r = pickTimingOption(o, "GTD");
    expect(r.fellBack).toBe(true);
    expect(r.option?.name).toBe("Public");
  });
});

describe("server stage choice", () => {
  const req: any = { chain: "robinhood", contract: "0x1", strategy: "opensea_api", wallets: [{ walletId: "a", quantity: 5 }, { walletId: "b", quantity: 1 }], runAt: "2030-01-01T00:00:00.000Z", offsetMs: -200, stage: "GTD" };
  it("uses the stage start (not the client time), eligible wallets only, stage per-wallet max", () => {
    const c = applyStageChoice(stages, rows, req, at("2026-10-22T09:22:00Z"));
    expect(c.req.runAt).toBe("2026-10-22T14:00:00.000Z");
    expect(c.req.offsetMs).toBe(-200);
    expect(c.req.wallets).toEqual([{ walletId: "a", quantity: 2 }]);
    expect(c.skipped).toEqual([{ walletId: "b", reason: "Not eligible for GTD. Skipped." }]);
  });
  it("live stage runs immediately without offset", () => {
    const c = applyStageChoice(stages, rows, req, at("2026-10-22T14:10:00Z"));
    expect(c.req.runAt).toBeNull();
    expect(c.req.offsetMs).toBe(0);
  });
  it("rejects ended stages and allowlist stages on the public-only strategy", () => {
    expect(() => applyStageChoice(stages, rows, req, at("2026-10-22T15:30:00Z"))).toThrow(/GTD/);
    expect(() => applyStageChoice(stages, rows, { ...req, strategy: "seadrop_public" }, at("2026-10-22T09:00:00Z"))).toThrow(/allowlist/);
  });
  it("Public uses every wallet", () => {
    const c = applyStageChoice(stages, rows, { ...req, stage: "Public (on-chain)" }, at("2026-10-22T09:22:00Z"));
    expect(c.req.wallets.map((w: any) => w.walletId)).toEqual(["a", "b"]);
    expect(c.req.wallets[0].quantity).toBe(3);
    expect(c.req.runAt).toBe("2026-10-22T16:00:00.000Z");
  });
});
