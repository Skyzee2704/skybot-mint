// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A5: prepareAll wiring tests with a mocked OpenSea mint API (no network, no keys, no txs).
 * The fake OpenSea answers like the real one: 422 naming the still-active previous stage
 * before T0, 200 naming the chosen stage (stage_uuid) from T0 on. These tests prove the
 * whole prepareAll path — probe → classify → build → sign — not just the classify unit.
 *
 * Acceptance covered here: GTD scheduled, FCFS scheduled, Mint Now (immediate execution,
 * no scheduling, 422 naming the live stage is final at once), F1 (a probe wallet on the
 * team list must not release the wave to the wrong stage; follow-mode "closed" is failed
 * with both stages named, not left pending), A1 (apostrophe stage name, end to end).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CHOSEN_DATA = "0x" + "aa".repeat(20);
const TEAM_DATA = "0x" + "bb".repeat(20);

const sim = vi.hoisted(() => ({
  fireAt: 0,
  target: null as any,
  handler: null as null | ((minter: string, quantity: number) => any),
  calls: [] as Array<{ minter: string; at: number; outcome: string }>,
  firstBuildAt: 0,
  signs: 0,
}));

const addr = (i: number) => "0x" + (i + 1).toString(16).padStart(40, "0");

vi.mock("../src/config/chains.js", async () => {
  const a = await vi.importActual<any>("../src/config/chains.js");
  return {
    ...a,
    requireChain: () => ({ key: "sim", chainId: 1, name: "Sim", nativeSymbol: "ETH", explorer: "" }),
  };
});
vi.mock("../src/core/rpc/pool.js", () => ({
  getPool: () => ({
    checkChainId: async () => {},
    read: async (_fn: any, kind: string) => {
      if (kind === "nonce") return 7;
      if (kind === "estimateGas") return 100_000n;
      throw new Error("unexpected read " + kind);
    },
  }),
}));
vi.mock("../src/core/resolver/cache.js", () => ({ getResolved: async () => sim.target }));
vi.mock("../src/core/mint/stage.js", () => ({
  stagePriceWei: () => 1n,
  osStage: () => ({ priceWei: "1", maxPerWallet: null }),
}));
vi.mock("../src/core/mint/fees.js", () => ({
  getFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  jobFeesIfFresh: () => null,
  feesMoved: () => false,
  rememberJobFees: () => {},
}));
vi.mock("../src/users/service.js", () => ({
  getWallet: async (_u: string, id: string) => ({
    address: addr(Number(id.slice(1))),
    privyWalletId: "pw-" + id,
  }),
}));
vi.mock("../src/core/safety/safety.js", () => ({
  assertDailyBudget: async () => {},
  recordSpend: async () => {},
  settleSpend: async () => {},
  assertSafeMintTx: async () => {},
  isDangerousFunctionName: () => false,
}));
vi.mock("../src/core/jobs/repo.js", async () => {
  class JobCancelledError extends Error {}
  return {
    JobCancelledError,
    appendJobLog: async () => {},
    jobStatus: async () => "running",
    patchJob: async () => {},
    recordMinted: async () => {},
  };
});
vi.mock("../src/auth/privy.js", () => ({
  signRawTransaction: async (_w: string, tx: any) => {
    sim.signs++;
    return `raw:${tx.data}:${tx.nonce}`;
  },
}));
vi.mock("../src/core/resolver/opensea.js", () => {
  class OpenSeaHttpError extends Error {
    status: number;
    retryAfterMs?: number;
    rateLimit?: any;
    constructor(status: number, message: string, retryAfterMs?: number, rateLimit?: any) {
      super(message);
      this.name = "OpenSeaHttpError";
      this.status = status;
      this.retryAfterMs = retryAfterMs;
      this.rateLimit = rateLimit;
    }
  }
  class OpenSeaClient {
    get available() {
      return true;
    }
    async buildMint(_slug: string, minter: string, quantity: number) {
      const res = sim.handler!(minter, quantity);
      if (!sim.firstBuildAt) sim.firstBuildAt = Date.now();
      sim.calls.push({ minter, at: Date.now(), outcome: res.outcome });
      if (res.error) throw new OpenSeaHttpError(res.error.status, res.error.message);
      return {
        to: "0x" + "a".repeat(40),
        data: res.data,
        value: "0x0",
        chain: "sim",
        stage_uuid: res.stageUuid,
        stage_type: "signed_presale",
        stage_start_time: res.stageStart,
        stage_end_time: null,
      };
    }
  }
  return { OpenSeaClient, OpenSeaHttpError };
});

function makeTarget(opts: {
  chosenName: string;
  chosenUuid?: string;
  chosenStart: string;
  prevName: string;
  prevUuid: string;
  prevStart: string;
}) {
  return {
    chain: { key: "sim" },
    contract: "0x" + "c".repeat(40),
    slug: "fake-drop",
    stages: [
      {
        name: opts.prevName,
        type: "allowlist",
        uuid: opts.prevUuid,
        priceWei: "1",
        start: opts.prevStart,
        end: opts.chosenStart,
        maxPerWallet: 2,
        status: "upcoming",
        source: "opensea",
      },
      {
        name: opts.chosenName,
        type: "allowlist",
        uuid: opts.chosenUuid,
        priceWei: "1",
        start: opts.chosenStart,
        end: null,
        maxPerWallet: 2,
        status: "upcoming",
        source: "opensea",
      },
    ],
    seadrop: null,
    generic: null,
    kalos: null,
    opensea: null,
  };
}

const err422 = (stageName: string) => ({
  error: {
    status: 422,
    message: `Wallet is not eligible for the active drop stage, '${stageName}' (signed_presale): the wallet is not on this stage's allowlist`,
  },
  outcome: "422-" + stageName,
});

async function runPrepare(opts: {
  wallets?: number;
  stage: string;
  fireAt?: number;
  buildNotBefore?: number;
  /** Build budget override (default fireAt + 30 s). Short deadlines keep retry-until-deadline tests fast. */
  buildDeadlineMs?: number;
  /** Pass no fireAt at all: the fireAt=undefined path (immediate-final 422). */
  noFireAt?: boolean;
}) {
  const { prepareAll } = await import("../src/core/mint/executor.js");
  const req: any = {
    chain: "sim",
    contract: "0x" + "c".repeat(40),
    strategy: "opensea_api",
    stage: opts.stage,
    wallets: Array.from({ length: opts.wallets ?? 3 }, (_, i) => ({ walletId: `w${i}`, quantity: 1 })),
  };
  const startedAt = Date.now();
  const fireAt = opts.fireAt ?? startedAt;
  const out = await prepareAll({ id: "job-sim", userId: "u" } as any, req, {}, opts.buildDeadlineMs ?? fireAt + 30_000, {
    ...(opts.noFireAt ? {} : { fireAt }),
    ...(opts.buildNotBefore !== undefined ? { buildNotBefore: opts.buildNotBefore } : {}),
    onSigned: async () => {},
  });
  return { out, startedAt, elapsedMs: Date.now() - startedAt };
}

describe("prepareAll stage wiring (mocked OpenSea, real build + classify)", () => {
  // Warm the (cached) module import once: a cold dynamic import inside the first runPrepare
  // would eat the 1500ms window before fireAt and the probe would never run pre-T0.
  beforeAll(async () => {
    await import("../src/core/mint/executor.js");
  });

  beforeEach(() => {
    sim.calls = [];
    sim.firstBuildAt = 0;
    sim.signs = 0;
    sim.handler = null;
  });

  it("GTD scheduled: probe 422 pre-T0 (team stage) retries past T0 and mints in the GTD stage", async () => {
    const fireAt = Date.now() + 1500;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = (minter: string) =>
      Date.now() < fireAt
        ? err422("Team Round")
        : { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
    const { out } = await runPrepare({ stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(3);
    expect(out.results.every((r) => r.status === "signed")).toBe(true);
    expect(out.prepared.every((p) => p.raw.includes(CHOSEN_DATA))).toBe(true);
    // The probe retried across T0: first call pre-T0 (422), a call at/after T0 (200).
    expect(sim.calls.some((c) => c.at < fireAt && c.outcome === "422-Team Round")).toBe(true);
    expect(sim.calls.some((c) => c.at >= fireAt && c.outcome === "200-gtd")).toBe(true);
  });

  it("FCFS scheduled: same path, FCFS stage", async () => {
    const fireAt = Date.now() + 1500;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "FCFS Round",
      chosenUuid: "uuid-fcfs",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () =>
      Date.now() < fireAt
        ? err422("Team Round")
        : { outcome: "200-fcfs", data: CHOSEN_DATA, stageUuid: "uuid-fcfs", stageStart: chosenStart };
    const { out } = await runPrepare({ wallets: 2, stage: "FCFS Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(2);
    expect(out.results.every((r) => r.status === "signed")).toBe(true);
    expect(out.prepared.every((p) => p.raw.includes(CHOSEN_DATA))).toBe(true);
  });

  it("F1: probe wallet on the team list gets a pre-T0 200 for the TEAM stage — the wave must NOT mint into it", async () => {
    // 3000ms lead (not 1500): under parallel load the first probe call can otherwise
    // land after T0 and the pre-T0 200 never happens — a test-timing flake, not a code bug.
    const fireAt = Date.now() + 3000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = (minter: string) => {
      if (Date.now() < fireAt) {
        // Wallet 0 IS on the team list: OpenSea builds a tx for the team stage.
        if (minter === addr(0)) return { outcome: "200-team", data: TEAM_DATA, stageUuid: "uuid-team", stageStart: prevStart };
        return err422("Team Round");
      }
      return { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
    };
    const { out } = await runPrepare({ stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    // The pre-T0 team 200 happened (the guard had something to reject)...
    expect(sim.calls.some((c) => c.at < fireAt && c.outcome === "200-team")).toBe(true);
    // ...but no prepared tx is built for the team stage: everything signed is GTD.
    expect(out.prepared).toHaveLength(3);
    expect(out.results.every((r) => r.status === "signed")).toBe(true);
    expect(out.prepared.every((p) => p.raw.includes(CHOSEN_DATA))).toBe(true);
    expect(out.prepared.some((p) => p.raw.includes(TEAM_DATA))).toBe(false);
  });

  it("F1a + Opsi 3 (round 3: F-N2 + F-N5): a follow-mode 'closed' RETRIES until the deadline, then fails naming both stages", async () => {
    const fireAt = Date.now() + 1500;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = (minter: string) => {
      if (Date.now() < fireAt) return err422("Team Round");
      // The probe (wallet 0) opens the gate; the other wallets still see the team stage.
      if (minter === addr(0)) return { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
      return err422("Team Round");
    };
    // Short budget: the retry-until-deadline behavior is proven without waiting 30 s.
    const { out } = await runPrepare({ stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150, buildDeadlineMs: fireAt + 2500 });
    expect(out.results[0]?.status).toBe("signed");
    for (const r of out.results.slice(1)) {
      expect(r.status).toBe("failed");
      // F-N5: the terminal error keeps the last 422 (both stages named, Opsi 3).
      expect(r.error).toContain("Team Round");
      expect(r.error).toContain("GTD Round");
      expect(r.error).toContain("build deadline");
    }
    expect(out.results.some((r) => r.status === "pending")).toBe(false);
    // F-N2: the follow wallets retried instead of failing at once — several 422s each.
    const followCalls = sim.calls.filter((c) => c.outcome === "422-Team Round");
    expect(followCalls.length).toBeGreaterThan(3);
  });

  it("A1 (wiring): a pre-T0 422 naming an apostrophe stage retries past T0 and mints", async () => {
    const fireAt = Date.now() + 1500;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Collector's Round",
      prevUuid: "uuid-col",
      prevStart,
    });
    sim.handler = () =>
      Date.now() < fireAt
        ? err422("Collector's Round")
        : { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
    const { out } = await runPrepare({ wallets: 1, stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(1);
    expect(out.results[0]?.status).toBe("signed");
  });

  it("Mint Now: executes immediately after the call (no scheduling, no probe-wait) and mints", async () => {
    const fireAt = Date.now() - 1000; // already past, as runJob passes startedAt for Mint Now
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () => ({ outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart });
    const { out, startedAt, elapsedMs } = await runPrepare({ wallets: 2, stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(2);
    expect(out.results.every((r) => r.status === "signed")).toBe(true);
    // The first build call happens right away — nothing waits for a schedule or a wave.
    expect(sim.firstBuildAt - startedAt).toBeLessThan(1000);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("Mint Now: a 422 naming the live stage itself is final at once (one build attempt, no retry)", async () => {
    const fireAt = Date.now() - 1000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "Allowlist Round",
      chosenUuid: "uuid-allow",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () => err422("Allowlist Round");
    const { out, elapsedMs } = await runPrepare({ wallets: 1, stage: "Allowlist Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(0);
    expect(out.results[0]?.status).toBe("failed");
    expect(out.results[0]?.error).toContain("Allowlist Round");
    expect(sim.calls).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("F-N6 (wiring): a pre-T0 'live' verdict (unfunded probe wallet on the team list) must NOT release the wave early", async () => {
    const fireAt = Date.now() + 1500;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = (minter: string) => {
      if (Date.now() < fireAt) {
        // Wallet 0 IS on the team list but unfunded: 422 insufficient funds is "live"
        // yet proves nothing about the GTD stage.
        if (minter === addr(0))
          return {
            error: { status: 422, message: "Wallet has insufficient funds for this mint" },
            outcome: "422-insufficient",
          };
        return err422("Team Round");
      }
      if (minter === addr(0))
        return {
          error: { status: 422, message: "Wallet has insufficient funds for this mint" },
          outcome: "422-insufficient",
        };
      return { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
    };
    const { out } = await runPrepare({ stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    // No wallet other than the probe ever called before T0: the wave was not released early.
    expect(sim.calls.filter((c) => c.at < fireAt).every((c) => c.minter === addr(0))).toBe(true);
    expect(out.results[0]?.status).toBe("failed");
    expect(out.results.slice(1).every((r) => r.status === "signed")).toBe(true);
    expect(out.prepared).toHaveLength(2);
    expect(out.prepared.every((p) => p.raw.includes(CHOSEN_DATA))).toBe(true);
  });

  it("N5 (A6): prepareAll fails fast when buildNotBefore is passed without fireAt", async () => {
    const { prepareAll } = await import("../src/core/mint/executor.js");
    const fireAt = Date.now() + 60_000;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart: new Date(fireAt).toISOString(),
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart: new Date(fireAt - 3600_000).toISOString(),
    });
    const req: any = {
      chain: "sim",
      contract: "0x" + "c".repeat(40),
      strategy: "opensea_api",
      stage: "GTD Round",
      wallets: [{ walletId: "w0", quantity: 1 }],
    };
    await expect(
      prepareAll({ id: "job-sim", userId: "u" } as any, req, {}, fireAt + 30_000, { buildNotBefore: fireAt - 150 }),
    ).rejects.toThrow("buildNotBefore without fireAt");
    expect(sim.calls).toHaveLength(0);
  });

  it("Mint Now decision (a) RETRY, current behavior: 422 naming another stage retries, stage flips at +2s, mints", async () => {
    const fireAt = Date.now() - 1000; // Mint Now: runJob passes startedAt
    const flipAt = Date.now() + 2000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () =>
      Date.now() < flipAt
        ? err422("Team Round")
        : { outcome: "200-gtd", data: CHOSEN_DATA, stageUuid: "uuid-gtd", stageStart: chosenStart };
    const { out, elapsedMs } = await runPrepare({ wallets: 1, stage: "GTD Round", fireAt, buildNotBefore: fireAt - 150 });
    expect(out.prepared).toHaveLength(1);
    expect(out.results[0]?.status).toBe("signed");
    // Data for the coordinator's decision: ~2 s to success, a handful of calls.
    expect(elapsedMs).toBeGreaterThanOrEqual(1500);
    expect(elapsedMs).toBeLessThan(8000);
    expect(sim.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Mint Now decision (b) RETRY, stage never flips: fails at the deadline WITH the 422 text (call-rate sample)", async () => {
    const fireAt = Date.now() - 1000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () => err422("Team Round");
    const { out, elapsedMs } = await runPrepare({
      wallets: 1,
      stage: "GTD Round",
      fireAt,
      buildNotBefore: fireAt - 150,
      buildDeadlineMs: fireAt + 6000,
    });
    expect(out.prepared).toHaveLength(0);
    expect(out.results[0]?.status).toBe("failed");
    expect(out.results[0]?.error).toContain("Team Round");
    expect(out.results[0]?.error).toContain("build deadline");
    // ~5 s of budget spent, calls counted here for the 30 s extrapolation in the report.
    expect(elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(elapsedMs).toBeLessThan(9000);
    expect(sim.calls.length).toBeGreaterThan(2);
  });

  it("Mint Now decision (c) IMMEDIATE-FINAL, the alternative: no fireAt means one call, instant fail", async () => {
    const fireAt = Date.now() - 1000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    sim.fireAt = fireAt;
    sim.target = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    sim.handler = () => err422("Team Round");
    const { out, elapsedMs } = await runPrepare({ wallets: 1, stage: "GTD Round", noFireAt: true });
    expect(out.prepared).toHaveLength(0);
    expect(out.results[0]?.status).toBe("failed");
    expect(out.results[0]?.error).toContain("Team Round");
    expect(sim.calls).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("buildMintTx stage verification (F1b, real build, fake OpenSea client)", () => {
  it("rejects a 200 built for another stage (WRONG_STAGE), before and after T0", async () => {
    const { buildMintTx } = await import("../src/core/mint/build.js");
    const fireAt = Date.now() + 60_000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    const t = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    const teamOs: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: TEAM_DATA,
        value: "0x0",
        chain: "sim",
        stage_uuid: "uuid-team",
        stage_type: "signed_presale",
        stage_start_time: prevStart,
        stage_end_time: chosenStart,
      }),
    };
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    await expect(buildMintTx(t as any, req, addr(1), 1, teamOs, "u", { fireAt })).rejects.toMatchObject({ code: "WRONG_STAGE" });
    await expect(buildMintTx(t as any, req, addr(1), 1, teamOs, "u", { fireAt: Date.now() - 1000 })).rejects.toMatchObject({
      code: "WRONG_STAGE",
    });
  });

  it("accepts a 200 for the chosen stage, by uuid or by matching start time", async () => {
    const { buildMintTx } = await import("../src/core/mint/build.js");
    const fireAt = Date.now() + 60_000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    const t = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    const gtdOs: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: CHOSEN_DATA,
        value: "0x0",
        chain: "sim",
        stage_uuid: "uuid-gtd",
        stage_type: "signed_presale",
        stage_start_time: chosenStart,
        stage_end_time: null,
      }),
    };
    const tx = await buildMintTx(t as any, req, addr(1), 1, gtdOs, "u", { fireAt });
    expect(tx.data).toBe(CHOSEN_DATA);
    // No uuid on either side: the start instant is enough to prove the same stage.
    const noUuidTarget = makeTarget({ chosenName: "GTD Round", chosenStart, prevName: "Team Round", prevUuid: "uuid-team", prevStart });
    delete (noUuidTarget.stages[1] as any).uuid;
    const startOs: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: CHOSEN_DATA,
        value: "0x0",
        chain: "sim",
        stage_type: "signed_presale",
        stage_start_time: chosenStart,
        stage_end_time: null,
      }),
    };
    const tx2 = await buildMintTx(noUuidTarget as any, req, addr(1), 1, startOs, "u", { fireAt });
    expect(tx2.data).toBe(CHOSEN_DATA);
  });

  it("N3 (wiring): a 200 whose stage_uuid is the dashed spelling of the resolved bare-hex uuid is accepted", async () => {
    const { buildMintTx } = await import("../src/core/mint/build.js");
    const fireAt = Date.now() - 1000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    const bare = "f7768398416f49dead4798ad09c31bc9";
    const dashed = "f7768398-416f-49de-ad47-98ad09c31bc9";
    const t = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: bare,
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    const dashedOs: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: CHOSEN_DATA,
        value: "0x0",
        chain: "sim",
        stage_uuid: dashed,
        stage_type: "signed_presale",
        stage_start_time: chosenStart,
        stage_end_time: null,
      }),
    };
    const tx = await buildMintTx(t as any, req, addr(1), 1, dashedOs, "u", { fireAt });
    expect(tx.data).toBe(CHOSEN_DATA);
    // Reverse spelling: resolved dashed, 200 bare hex.
    const t2 = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: dashed,
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    const bareOs: any = {
      available: true,
      buildMint: async () => ({
        to: "0x" + "a".repeat(40),
        data: CHOSEN_DATA,
        value: "0x0",
        chain: "sim",
        stage_uuid: bare,
        stage_type: "signed_presale",
        stage_start_time: chosenStart,
        stage_end_time: null,
      }),
    };
    const tx2 = await buildMintTx(t2 as any, req, addr(1), 1, bareOs, "u", { fireAt });
    expect(tx2.data).toBe(CHOSEN_DATA);
  });

  it("refuses an unverifiable 200 before T0, trusts it once the stage is open", async () => {
    const { buildMintTx } = await import("../src/core/mint/build.js");
    const fireAt = Date.now() + 60_000;
    const chosenStart = new Date(fireAt).toISOString();
    const prevStart = new Date(fireAt - 3600_000).toISOString();
    const t = makeTarget({
      chosenName: "GTD Round",
      chosenUuid: "uuid-gtd",
      chosenStart,
      prevName: "Team Round",
      prevUuid: "uuid-team",
      prevStart,
    });
    const req: any = { chain: "sim", contract: t.contract, strategy: "opensea_api", stage: "GTD Round", wallets: [] };
    const blankOs: any = {
      available: true,
      buildMint: async () => ({ to: "0x" + "a".repeat(40), data: CHOSEN_DATA, value: "0x0", chain: "sim" }),
    };
    await expect(buildMintTx(t as any, req, addr(1), 1, blankOs, "u", { fireAt })).rejects.toMatchObject({ code: "WRONG_STAGE" });
    const tx = await buildMintTx(t as any, req, addr(1), 1, blankOs, "u", { fireAt: Date.now() - 1000 });
    expect(tx.data).toBe(CHOSEN_DATA);
  });
});

describe("buildFailureMessage names both stages (Opsi 3)", () => {
  it("a final 422 naming another stage leads with the chosen stage + the active stage", async () => {
    const { MintBuildError } = await import("../src/core/mint/build.js");
    const { buildFailureMessage } = await import("../src/core/mint/jobErrors.js");
    const err = new MintBuildError(
      "OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale): the wallet is not on this stage's allowlist",
      "NOT_ELIGIBLE",
    );
    const msg = await buildFailureMessage(
      err,
      { chain: { nativeSymbol: "ETH" } as any, contract: "0x" + "c".repeat(40) },
      { chosenStage: "GTD Round" },
    );
    expect(msg).toContain("GTD Round");
    expect(msg).toContain("Team Round");
    expect(msg.indexOf("GTD Round")).toBeLessThan(msg.indexOf("OpenSea:"));
    // Same stage: no rewrite, the raw message stands.
    const same = await buildFailureMessage(
      err,
      { chain: { nativeSymbol: "ETH" } as any, contract: "0x" + "c".repeat(40) },
      { chosenStage: "Team Round" },
    );
    expect(same).toBe(
      "OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale): the wallet is not on this stage's allowlist",
    );
  });
});
