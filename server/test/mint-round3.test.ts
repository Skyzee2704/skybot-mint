// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round-3 dry tests (debug total SkyBOT Mint, 2026-11-21). Fake OpenSea + fake clock,
 * no mint, no transaction, no network. Covers the round-2 follow-ups (F-N1–F-N5, N1–N7)
 * and the new gaps found in the round-3 audit (F-N6–F-N8).
 *
 * Pure units live here; prepareAll wiring lives in prepare-all-stage.test.ts and the
 * simulate wiring in simulate-stage.test.ts (each file carries its own vi.mock set).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/chains.js", async () => {
  const a = await vi.importActual<any>("../src/config/chains.js");
  return {
    ...a,
    requireChain: () => ({ key: "sim", chainId: 1, name: "Sim", nativeSymbol: "ETH", explorer: "" }),
  };
});
vi.mock("../src/core/safety/safety.js", () => ({
  assertDailyBudget: async () => {},
  recordSpend: async () => {},
  settleSpend: async () => {},
  assertSafeMintTx: async () => {},
  isDangerousFunctionName: () => false,
}));

import {
  classifyNotEligible,
  matchesChosenStage,
  mintStageMatchesOsStage,
  parseOpenSeaActiveStage,
} from "../src/core/mint/stageVerdict.js";
import { isTransientTransportError, MintBuildError, buildMintTx } from "../src/core/mint/build.js";
import { buildFailureMessage } from "../src/core/mint/jobErrors.js";
import { pickTimingOption } from "../src/core/mint/stageEligibility.js";
import { probeAndRelease, type ProbeCall } from "../src/core/mint/openseaLimit.js";
import { noMintReason } from "../src/jobs/scheduler.js";

const addr = (i: number) => "0x" + (i + 1).toString(16).padStart(40, "0");

function clock(start: number) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("F-N8 plumbing: buildMintTx reports the stage the 200 was built for", () => {
  it("onMintStage receives the mint API's stage (uuid + start)", async () => {
    const t: any = {
      chain: { key: "sim" },
      contract: "0x" + "c".repeat(40),
      slug: "fake-drop",
      stages: [
        {
          name: "GTD Round",
          type: "allowlist",
          uuid: "uuid-gtd",
          priceWei: "1",
          start: new Date(Date.now() - 1000).toISOString(),
          end: null,
          maxPerWallet: 2,
          status: "active",
          source: "opensea",
        },
      ],
      seadrop: null,
      generic: null,
      kalos: null,
      opensea: null,
    };
    const os: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: "0x" + "cc".repeat(20),
        value: "0x0",
        chain: "sim",
        stage_uuid: "uuid-gtd",
        stage_type: "signed_presale",
        stage_start_time: t.stages[0].start,
        stage_end_time: null,
      }),
    };
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    let seen: any;
    await buildMintTx(t, req, addr(1), 1, os, "u", { fireAt: Date.now() - 1000, onMintStage: (s) => (seen = s) });
    expect(seen?.uuid).toBe("uuid-gtd");
    expect(seen?.startTime).toBe(t.stages[0].start);
  });
});

describe("N3: uuid matching is spelling-insensitive (dashed vs bare hex)", () => {
  const bare = "f7768398416f49dead4798ad09c31bc9";
  const dashed = "f7768398-416f-49de-ad47-98ad09c31bc9";
  const other = "cc267f20a2ec4b43b698b73597a838b7";
  it("matchesChosenStage: dashed 200 vs bare-hex resolved stage (and reverse)", () => {
    expect(matchesChosenStage({ uuid: bare, start: null }, { uuid: dashed })).toBe(true);
    expect(matchesChosenStage({ uuid: dashed, start: null }, { uuid: bare })).toBe(true);
    expect(matchesChosenStage({ uuid: "F7768398-416F-49DE-AD47-98AD09C31BC9", start: null }, { uuid: bare })).toBe(true);
    expect(matchesChosenStage({ uuid: bare, start: null }, { uuid: other })).toBe(false);
  });
  it("mintStageMatchesOsStage: same rule for the checker's drops-API stage", () => {
    expect(mintStageMatchesOsStage({ uuid: dashed }, { uuid: bare })).toBe(true);
    expect(mintStageMatchesOsStage({ uuid: bare }, { uuid: dashed })).toBe(true);
    expect(mintStageMatchesOsStage({ uuid: other }, { uuid: bare })).toBe(false);
    expect(mintStageMatchesOsStage(undefined, { uuid: bare })).toBeUndefined();
    expect(mintStageMatchesOsStage({ startTime: "2026-11-21T10:00:00.000Z" }, { start_time: "2026-11-21T10:00:00.000Z" })).toBe(true);
    expect(mintStageMatchesOsStage({ startTime: "2026-11-21T10:00:00.000Z" }, { start_time: "2026-11-21T11:00:00.000Z" })).toBe(false);
  });
});

describe("N7: stage name with an apostrophe parses whole without a ' (type)' suffix", () => {
  it("bare fallback keeps the apostrophe", () => {
    expect(parseOpenSeaActiveStage("Wallet is not eligible for the active drop stage, 'Collector's Round'")).toBe("Collector's Round");
    expect(parseOpenSeaActiveStage("Wallet is not eligible for the active drop stage 'Collector's Round'.")).toBe("Collector's Round");
    expect(parseOpenSeaActiveStage("Wallet is not eligible for the active drop stage, 'Team Round'")).toBe("Team Round");
  });
  it("a 422 naming an apostrophe stage still classifies against the chosen stage", () => {
    const fireAt = 10_000;
    const msg = "OpenSea: Wallet is not eligible for the active drop stage, 'Collector's Round' (signed_presale)";
    expect(classifyNotEligible({ message: msg, fireAt, chosenStage: "GTD Round", now: fireAt + 1000 })).toBe("closed");
    expect(classifyNotEligible({ message: msg, fireAt, chosenStage: "Collector's Round", now: fireAt + 1000 })).toBe("live");
  });
});

describe("F-N3: pickTimingOption is case-insensitive", () => {
  const opts: any[] = [
    {
      key: "GTD Round",
      kind: "stage",
      stage: { name: "GTD Round" },
      name: "GTD Round",
      live: false,
      runAt: "2026-11-21T10:00:00Z",
      walletIds: ["w0"],
      skipped: [],
    },
    {
      key: "Public",
      kind: "stage",
      stage: { name: "Public", type: "public" },
      name: "Public",
      live: false,
      runAt: "2026-11-21T11:00:00Z",
      walletIds: ["w0"],
      skipped: [],
    },
  ];
  it("finds the stage regardless of case / surrounding spaces", () => {
    expect(pickTimingOption(opts, "gtd round").option?.key).toBe("GTD Round");
    expect(pickTimingOption(opts, "  GTD ROUND  ").option?.key).toBe("GTD Round");
    expect(pickTimingOption(opts, "gtd round").fellBack).toBe(false);
  });
  it("still falls back to Public for an unknown name", () => {
    const r = pickTimingOption(opts, "No Such Stage");
    expect(r.option?.key).toBe("Public");
    expect(r.fellBack).toBe(true);
  });
});

describe("F-N7: transient transport errors are RETRY (promote), safety stays terminal", () => {
  it("isTransientTransportError matches only network failures", () => {
    expect(isTransientTransportError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientTransportError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientTransportError(new Error("socket hang up"))).toBe(true);
    expect(isTransientTransportError(Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }))).toBe(true);
    expect(isTransientTransportError(new Error("Blocked: tx value 1 is above the stage price"))).toBe(false);
    expect(isTransientTransportError(new Error("invalid address"))).toBe(false);
  });

  it("buildMintTx maps a socket failure to RETRY instead of rethrowing raw", async () => {
    const t: any = {
      chain: { key: "sim" },
      contract: "0x" + "c".repeat(40),
      slug: "fake-drop",
      stages: [
        {
          name: "GTD Round",
          type: "allowlist",
          uuid: "uuid-gtd",
          priceWei: "1",
          start: new Date(Date.now() - 1000).toISOString(),
          end: null,
          maxPerWallet: 2,
          status: "active",
          source: "opensea",
        },
      ],
      seadrop: null,
      generic: null,
      kalos: null,
      opensea: null,
    };
    const flakyOs: any = {
      available: true,
      buildMint: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    await expect(buildMintTx(t, req, addr(1), 1, flakyOs, "u", { fireAt: Date.now() - 1000 })).rejects.toMatchObject({
      code: "RETRY",
    });
  });
});

describe("N4: a chosen stage the fresh resolve does not know fails fast", () => {
  it("buildMintTx throws STAGE instead of skipping the guard", async () => {
    const t: any = {
      chain: { key: "sim" },
      contract: "0x" + "c".repeat(40),
      slug: "fake-drop",
      stages: [
        {
          name: "Team Round",
          type: "allowlist",
          uuid: "uuid-team",
          priceWei: "1",
          start: new Date(Date.now() - 3600_000).toISOString(),
          end: null,
          maxPerWallet: 2,
          status: "active",
          source: "opensea",
        },
      ],
      seadrop: null,
      generic: null,
      kalos: null,
      opensea: null,
    };
    const os: any = { available: true, buildMint: async () => ({ to: "0x" + "a".repeat(40), data: "0x", value: "0x0", chain: "sim" }) };
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    await expect(buildMintTx(t, req, addr(1), 1, os, "u", { fireAt: Date.now() - 1000 })).rejects.toMatchObject({ code: "STAGE" });
  });
});

describe("N6: noMintReason always names the failure (mixed pending+failed included)", () => {
  it("mixed pending+failed names both counts and the first reason", () => {
    const r = noMintReason([
      { status: "failed", error: "OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale)" },
      { status: "pending" },
    ]);
    expect(r).toContain("1 failed");
    expect(r).toContain("1 never reached a verdict");
    expect(r).toContain("Team Round");
  });
  it("all failed, all pending, empty, and minted", () => {
    expect(noMintReason([{ status: "failed", error: "boom" }])).toContain("1 failed");
    expect(noMintReason([{ status: "pending" }, { status: "pending" }])).toContain("2 never reached a verdict");
    expect(noMintReason([])).toContain("no wallets");
    expect(noMintReason([{ status: "failed" }, { status: "confirmed" }])).toBeNull();
    expect(noMintReason([{ status: "broadcast" }])).toBeNull();
  });
});

describe("F-N5: a build-deadline failure keeps the original 422 text", () => {
  it("buildFailureMessage does not truncate the preserved answer to 160 chars", async () => {
    const msg =
      "build deadline reached — last OpenSea answer: OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale): the wallet is not on this stage's allowlist";
    const out = await buildFailureMessage(
      new Error(msg),
      { chain: { nativeSymbol: "ETH" } as any, contract: "0x" + "c".repeat(40) },
      { chosenStage: "GTD Round" },
    );
    expect(out).toContain("Team Round");
    expect(out).toContain("GTD Round");
    expect(out).toContain("build deadline");
    expect(out.length).toBeGreaterThan(160);
  });
});

describe("probeAndRelease round-3 (fake clock)", () => {
  const err422 = (stage: string) =>
    new Error(
      `OpenSea: Wallet is not eligible for the active drop stage, '${stage}' (signed_presale): the wallet is not on this stage's allowlist`,
    );

  it("F-N2: a follow-mode 'closed' retries until the deadline, then fails WITH the last 422", async () => {
    const fireAt = 10_000;
    const c = clock(fireAt);
    const calls: number[][] = [[], [], []];
    const failed: Array<{ i: number; error: unknown }> = [];
    const report = await probeAndRelease<number>({
      count: 3,
      fireAt,
      deadline: fireAt + 3_000,
      now: c.now,
      sleep: c.sleep,
      call: async (i) => {
        calls[i]!.push(c.now());
        if (i === 0) return { kind: "ok", value: i };
        return { kind: "closed", error: err422("Team Round") };
      },
      onFail: async (i, error) => {
        failed.push({ i, error });
      },
    });
    expect(report.results[0]?.state).toBe("ok");
    expect(report.results[1]?.state).toBe("error");
    expect(report.results[2]?.state).toBe("error");
    // Retried, not failed at once: several attempts per follow wallet.
    expect(calls[1]!.length).toBeGreaterThan(2);
    expect(calls[2]!.length).toBeGreaterThan(2);
    // Terminal error still names the stage (F-N5) and the deadline.
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(String((f.error as Error)?.message ?? f.error)).toContain("Team Round");
      expect(String((f.error as Error)?.message ?? f.error)).toContain("build deadline");
    }
    expect(report.results.some((r) => r.state === "pending")).toBe(false);
  });

  it("F-N6: a pre-T0 'live' verdict (unfunded probe wallet) does NOT release the wave early", async () => {
    const fireAt = 10_000;
    const c = clock(fireAt - 150);
    const calls: number[][] = [[], [], []];
    const report = await probeAndRelease<number>({
      count: 3,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async (i) => {
        calls[i]!.push(c.now());
        if (c.now() < fireAt) {
          // Wallet 0 IS on the team list but unfunded: 422 insufficient funds is a
          // "live" verdict that proves nothing about the chosen stage.
          if (i === 0) return { kind: "live", error: new Error("OpenSea: Wallet has insufficient funds for this mint") };
          return { kind: "closed", error: err422("Team Round") };
        }
        if (i === 0) return { kind: "live", error: new Error("OpenSea: Wallet has insufficient funds for this mint") };
        return { kind: "ok", value: i };
      },
    });
    // The other wallets never fired before T0: the wave was not released early.
    expect(calls[1]!.every((t) => t >= fireAt)).toBe(true);
    expect(calls[2]!.every((t) => t >= fireAt)).toBe(true);
    expect(report.results[0]?.state).toBe("error");
    expect(report.results[1]?.state).toBe("ok");
    expect(report.results[2]?.state).toBe("ok");
  });

  it("F-N5 (probe): a wallet that only ever sees 'closed' fails at the deadline with its last answer", async () => {
    const fireAt = 10_000;
    const c = clock(fireAt - 150);
    let failed: unknown;
    const report = await probeAndRelease<number>({
      count: 1,
      fireAt,
      deadline: fireAt + 1_000,
      now: c.now,
      sleep: c.sleep,
      call: async () => ({ kind: "closed", error: err422("Team Round") }),
      onFail: async (_i, error) => {
        failed = error;
      },
    });
    expect(report.results[0]?.state).toBe("error");
    expect(String((failed as Error)?.message ?? failed)).toContain("build deadline");
    expect(String((failed as Error)?.message ?? failed)).toContain("Team Round");
  });
});
