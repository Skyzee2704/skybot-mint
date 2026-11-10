// SPDX-License-Identifier: AGPL-3.0-only
// Dry run of the scheduled-mint critical path. No RPC, no Privy, no broadcast.
// The phase order matches server/src/jobs/scheduler.ts (runJob) and
// server/src/core/mint/executor.ts (prepareAll). Times are milliseconds relative to T0,
// the stage start plus the user's offset. A negative number is before T0.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_CONCURRENCY, GAS_ESTIMATE_BUDGET_MS, NOT_ACTIVE_RETRY_MS, OPENSEA_LEAD_MS } from "../src/core/mint/executor.js";

const schedulerSrc = readFileSync(new URL("../src/jobs/scheduler.ts", import.meta.url), "utf8");
const envSrc = readFileSync(new URL("../src/config/env.ts", import.meta.url), "utf8");

/** Pulled from source so this model cannot silently drift from the constants it claims to mirror. */
function constMs(src: string, name: string): number {
  const m = src.match(new RegExp(`${name}(?:[^=\\n]*=\\s*|",\\s*)([0-9_]+)`));
  if (!m) throw new Error(`missing ${name}`);
  return Number(m[1].replace(/_/g, ""));
}

const PRESIGN_LEAD_MS = constMs(schedulerSrc, "PRESIGN_LEAD_MS");
const JOB_LEAD_MS = constMs(envSrc, "JOB_LEAD_MS");

export interface DryPhases {
  /** QStash delivery after the intended wake (T0 − JOB_LEAD_MS). 0 = on time. */
  qstashLate: number;
  /** Process start after the HTTP request arrives (cold start + DB claim). */
  coldStart: number;
  /** max(chain id, resolve, fee read, wallet load), once per job. */
  setup: number;
  /** One OpenSea mint-API round trip. Ignored for local-calldata strategies. */
  openseaRtt: number;
  /** When OpenSea stops returning 409, relative to T0. 0 = open exactly at the start. */
  openseaOpensAt: number;
  buildLocal: number;
  gasEstimate: number;
  privySign: number;
  /** beginBroadcast conditional UPDATE, on the path after T0. */
  dbClaim: number;
  broadcastRtt: number;
  wallets: number;
}

export interface DryWallet {
  ready: number;
  sendStart: number;
  mempool: number;
}

export interface DryRun {
  /** direct_contract: mintAllowList or mintSigned calldata already in hand before the presign window. */
  strategy: "seadrop_public" | "generic" | "opensea_api" | "direct_contract";
  prepStart: number;
  firstSend: number;
  lastSend: number;
  firstMempool: number;
  lastMempool: number;
  wallets: DryWallet[];
}

/**
 * Mirror of runJob + prepareAll.
 * Resolve and fees start when the function wakes. Nonces and local signing start at T−PRESIGN_LEAD_MS
 * (or when resolve finishes, if that is later). opensea_api starts the mint API at T0−OPENSEA_LEAD_MS,
 * retries 409 every NOT_ACTIVE_RETRY_MS, and caps a late gas estimate at GAS_ESTIMATE_BUDGET_MS.
 * direct_contract is the same local path, for a proof or signature already in hand.
 * beginBroadcast runs before T0, so it is not on the post-T0 send path. Kalos builds locally and does not use this API loop.
 */
const LOCAL = new Set<DryRun["strategy"]>(["seadrop_public", "generic", "direct_contract"]);

export function dryRun(strategy: DryRun["strategy"], p: DryPhases): DryRun {
  const wake = -JOB_LEAD_MS + p.qstashLate;
  const runStart = wake + p.coldStart;
  const setupDone = runStart + p.setup;
  const prepStart = Math.max(setupDone, -PRESIGN_LEAD_MS);

  const readyAt: number[] = [];
  if (!LOCAL.has(strategy)) {
    // The mint build starts OPENSEA_LEAD_MS before T0. A 409 costs one round trip plus NOT_ACTIVE_RETRY_MS.
    let attempt = Math.max(-OPENSEA_LEAD_MS, setupDone);
    for (;;) {
      if (attempt >= p.openseaOpensAt) break;
      attempt += p.openseaRtt + NOT_ACTIVE_RETRY_MS;
      if (attempt > 60_000) throw new Error("opensea never opened in the model");
    }
    const gas = Math.min(p.gasEstimate, GAS_ESTIMATE_BUDGET_MS);
    const one = p.openseaRtt + gas + p.privySign;
    for (let i = 0; i < p.wallets; i++) {
      const wave = Math.floor(i / BUILD_CONCURRENCY);
      readyAt.push(attempt + one * (wave + 1));
    }
  } else {
    const one = p.buildLocal + p.gasEstimate + p.privySign;
    for (let i = 0; i < p.wallets; i++) {
      const wave = Math.floor(i / BUILD_CONCURRENCY);
      readyAt.push(prepStart + one * (wave + 1));
    }
  }

  const firstReady = Math.min(...readyAt);
  const gateDone = Math.max(0, firstReady);
  const wallets: DryWallet[] = readyAt.map((ready) => {
    const sendStart = Math.max(ready, gateDone);
    return { ready, sendStart, mempool: sendStart + p.broadcastRtt };
  });
  const sends = wallets.map((w) => w.sendStart);
  const pools = wallets.map((w) => w.mempool);
  return {
    strategy,
    prepStart,
    firstSend: Math.min(...sends),
    lastSend: Math.max(...sends),
    firstMempool: Math.min(...pools),
    lastMempool: Math.max(...pools),
    wallets,
  };
}

const base: DryPhases = {
  qstashLate: 0,
  coldStart: 0,
  setup: 200,
  openseaRtt: 120,
  openseaOpensAt: 0,
  buildLocal: 1,
  gasEstimate: 40,
  privySign: 300,
  dbClaim: 25,
  broadcastRtt: 40,
  wallets: 8,
};

describe("scheduled mint dry run", () => {
  it("locks the lead and retry constants the model mirrors", () => {
    expect(PRESIGN_LEAD_MS).toBe(5000);
    expect(JOB_LEAD_MS).toBe(60_000);
    expect(NOT_ACTIVE_RETRY_MS).toBe(75);
    expect(OPENSEA_LEAD_MS).toBe(150);
    expect(GAS_ESTIMATE_BUDGET_MS).toBe(400);
    expect(BUILD_CONCURRENCY).toBe(8);
    expect(schedulerSrc).toContain("buildNotBefore: fireAt - OPENSEA_LEAD_MS");
    expect(schedulerSrc).toContain("await waitUntil(fireAt");
    expect(schedulerSrc).toContain("beginBroadcast");
  });

  it("SeaDrop public: sign before T0, first send at T0, never earlier", () => {
    const r = dryRun("seadrop_public", base);
    // Signing starts at T−5000 (resolve already finished at wake). One wave is 1+40+300 ms.
    expect(r.prepStart).toBe(-5000);
    expect(r.wallets[0]!.ready).toBe(-5000 + 341);
    expect(r.wallets.every((w) => w.ready < 0)).toBe(true);
    expect(r.firstSend).toBe(0);
    expect(r.firstMempool).toBe(40);
    expect(r.lastSend).toBe(r.firstSend);
    expect(r.firstSend).toBeGreaterThanOrEqual(0);
  });

  it("generic contracts follow the same local-calldata path as SeaDrop public", () => {
    const generic = dryRun("generic", base);
    const seadrop = dryRun("seadrop_public", base);
    expect(generic.prepStart).toBe(seadrop.prepStart);
    expect(generic.firstSend).toBe(seadrop.firstSend);
    expect(generic.firstMempool).toBe(seadrop.firstMempool);
    expect(generic.wallets).toEqual(seadrop.wallets);
  });

  it("resolve at wake: a multi-second resolve still leaves the presign window intact", () => {
    const r = dryRun("seadrop_public", { ...base, setup: 4500, privySign: 800 });
    expect(r.prepStart).toBe(-5000);
    expect(r.wallets[0]!.ready).toBeLessThan(0);
    expect(r.firstSend).toBe(0);
  });

  it("a resolve that runs past the presign point can still push signing past T0", () => {
    const r = dryRun("seadrop_public", { ...base, setup: 59_200, privySign: 800 });
    // Wake at T−60s, resolve ends at T−800ms, then 1+40+800 ms of signing.
    expect(r.prepStart).toBe(-800);
    expect(r.wallets[0]!.ready).toBe(41);
    expect(r.firstSend).toBe(41);
  });

  it("direct contract with the proof or signature already in hand matches SeaDrop public and beats the API", () => {
    const direct = dryRun("direct_contract", base);
    const api = dryRun("opensea_api", base);
    expect(direct.firstMempool).toBe(40);
    expect(direct.wallets.every((w) => w.ready < 0)).toBe(true);
    expect(api.firstMempool).toBe(545);
    expect(api.wallets.every((w) => w.ready > 0)).toBe(true);
    expect(api.firstMempool - direct.firstMempool).toBe(505);
  });

  it("OpenSea: the successful signature is after T0; 409 retries add 75ms after each round trip", () => {
    const open = dryRun("opensea_api", { ...base, wallets: 1 });
    // First try at T−150 returns before the stage opens, then the next try is after T0.
    expect(open.wallets[0]!.ready).toBe(45 + 120 + Math.min(40, 400) + 300);
    expect(open.firstSend).toBe(505);
    expect(open.firstMempool).toBe(545);
    expect(open.firstSend).toBeGreaterThan(0);

    // API still 409 at T0 (opens at +250). Attempts walk forward by RTT + 75ms.
    const late = dryRun("opensea_api", { ...base, wallets: 1, openseaOpensAt: 250 });
    expect(late.wallets[0]!.ready).toBe(435 + 120 + 40 + 300);
    expect(late.firstSend).toBe(895);
  });

  it("16 SeaDrop wallets: two waves, both still inside the presign window at these speeds", () => {
    const r = dryRun("seadrop_public", { ...base, wallets: 16 });
    expect(r.wallets[0]!.ready).toBe(r.wallets[7]!.ready);
    expect(r.wallets[8]!.ready).toBe(r.wallets[0]!.ready + 341);
    expect(r.wallets[15]!.ready).toBeLessThan(0);
    expect(r.firstSend).toBe(0);
    expect(r.lastSend).toBe(0);
  });

  it("QStash on time absorbs a 2s cold start; a wake inside the last 5s does not", () => {
    const warm = dryRun("seadrop_public", { ...base, coldStart: 2000 });
    expect(warm.prepStart).toBe(-5000);
    expect(warm.firstSend).toBe(0);

    // Delivered 58s late: function starts at T−2000, prep begins immediately, signing may miss T0.
    const lateWake = dryRun("seadrop_public", { ...base, qstashLate: 58_000, coldStart: 0, setup: 1500, privySign: 800 });
    expect(lateWake.prepStart).toBe(-500);
    expect(lateWake.wallets[0]!.ready).toBeGreaterThan(0);
    expect(lateWake.firstSend).toBeGreaterThan(0);
  });

  it("no scenario broadcasts before T0", () => {
    const cases: DryPhases[] = [
      base,
      { ...base, qstashLate: 0, coldStart: 0, setup: 0, privySign: 0, gasEstimate: 0, dbClaim: 0, broadcastRtt: 1 },
      { ...base, openseaOpensAt: -5000, openseaRtt: 10 },
      { ...base, wallets: 40, privySign: 50 },
    ];
    for (const c of cases) {
      for (const s of ["seadrop_public", "generic", "direct_contract", "opensea_api"] as const) {
        const r = dryRun(s, c);
        expect(r.firstSend).toBeGreaterThanOrEqual(0);
        expect(r.wallets.every((w) => w.sendStart >= 0)).toBe(true);
      }
    }
  });
});
