// SPDX-License-Identifier: AGPL-3.0-only
// Dry run of the scheduled-mint critical path. No RPC, no Privy, no broadcast.
// The phase order matches server/src/jobs/scheduler.ts (runJob) and
// server/src/core/mint/executor.ts (prepareAll). Times are milliseconds relative to T0,
// the stage start plus the user's offset. A negative number is before T0.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_CONCURRENCY, GAS_ESTIMATE_BUDGET_MS, NOT_ACTIVE_RETRY_MS } from "../src/core/mint/executor.js";

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
 * Local strategies (seadrop_public, generic) encode calldata in-process and sign inside the presign window.
 * opensea_api holds the real build until T0, retries 409 every NOT_ACTIVE_RETRY_MS, and caps a late gas
 * estimate at GAS_ESTIMATE_BUDGET_MS. Broadcast is gated on waitUntil(T0) then beginBroadcast.
 */
const LOCAL = new Set<DryRun["strategy"]>(["seadrop_public", "generic", "direct_contract"]);

export function dryRun(strategy: DryRun["strategy"], p: DryPhases): DryRun {
  const wake = -JOB_LEAD_MS + p.qstashLate;
  const runStart = wake + p.coldStart;
  const prepStart = Math.max(runStart, -PRESIGN_LEAD_MS);
  const setupDone = prepStart + p.setup;

  const readyAt: number[] = [];
  if (!LOCAL.has(strategy)) {
    // Setup (resolve, fees, nonces) runs in the presign window. The mint build itself is held until T0,
    // or until setup finishes if that is already after T0. A 409 costs one round trip plus NOT_ACTIVE_RETRY_MS.
    let attempt = Math.max(0, setupDone);
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
      readyAt.push(setupDone + one * (wave + 1));
    }
  }

  const firstReady = Math.min(...readyAt);
  const gateDone = Math.max(0, firstReady) + p.dbClaim;
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
    expect(NOT_ACTIVE_RETRY_MS).toBe(300);
    expect(GAS_ESTIMATE_BUDGET_MS).toBe(400);
    expect(BUILD_CONCURRENCY).toBe(8);
    expect(schedulerSrc).toContain('req.strategy === "opensea_api" ? { buildNotBefore: fireAt }');
    expect(schedulerSrc).toContain("await waitUntil(fireAt");
    expect(schedulerSrc).toContain("beginBroadcast");
  });

  it("SeaDrop public: sign before T0, first send at T0 plus the DB claim, never earlier", () => {
    const r = dryRun("seadrop_public", base);
    // setup 200 + one wave of 1+40+300 = 541ms, starting at T−5000.
    expect(r.prepStart).toBe(-5000);
    expect(r.wallets[0]!.ready).toBe(-5000 + 200 + 341);
    expect(r.wallets.every((w) => w.ready < 0)).toBe(true);
    expect(r.firstSend).toBe(25);
    expect(r.firstMempool).toBe(65);
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

  it("a slow resolve inside the 5s window pushes SeaDrop signing past T0", () => {
    const r = dryRun("seadrop_public", { ...base, setup: 4500, privySign: 800 });
    // setupDone = -500, wallet = 1+40+800 = 841 → ready at 341.
    expect(r.wallets[0]!.ready).toBe(341);
    expect(r.firstSend).toBe(341 + 25);
    expect(r.firstMempool).toBe(366 + 40);
  });

  it("direct contract with the proof or signature already in hand matches SeaDrop public and beats the API", () => {
    const direct = dryRun("direct_contract", base);
    const api = dryRun("opensea_api", base);
    expect(direct.firstMempool).toBe(65);
    expect(direct.wallets.every((w) => w.ready < 0)).toBe(true);
    expect(api.firstMempool).toBe(525);
    expect(api.wallets.every((w) => w.ready > 0)).toBe(true);
    expect(api.firstMempool - direct.firstMempool).toBe(460);
  });

  it("OpenSea: nothing is signed before T0; 409 retries add 300ms after each round trip", () => {
    const open = dryRun("opensea_api", { ...base, wallets: 1 });
    expect(open.wallets[0]!.ready).toBe(0 + 120 + Math.min(40, 400) + 300);
    expect(open.firstSend).toBe(460 + 25);
    expect(open.firstMempool).toBe(525);
    expect(open.firstSend).toBeGreaterThan(0);

    // API still 409 at T0 (opens at +250). Attempt at 0 costs 120ms, then sleep 300, attempt at 420 succeeds.
    const late = dryRun("opensea_api", { ...base, wallets: 1, openseaOpensAt: 250 });
    expect(late.wallets[0]!.ready).toBe(420 + 120 + 40 + 300);
    expect(late.firstSend).toBe(880 + 25);
  });

  it("16 SeaDrop wallets: two waves, both still inside the presign window at these speeds", () => {
    const r = dryRun("seadrop_public", { ...base, wallets: 16 });
    expect(r.wallets[0]!.ready).toBe(r.wallets[7]!.ready);
    expect(r.wallets[8]!.ready).toBe(r.wallets[0]!.ready + 341);
    expect(r.wallets[15]!.ready).toBeLessThan(0);
    expect(r.firstSend).toBe(25);
    expect(r.lastSend).toBe(25);
  });

  it("QStash on time absorbs a 2s cold start; a wake inside the last 5s does not", () => {
    const warm = dryRun("seadrop_public", { ...base, coldStart: 2000 });
    expect(warm.prepStart).toBe(-5000);
    expect(warm.firstSend).toBe(25);

    // Delivered 58s late: function starts at T−2000, prep begins immediately, signing may miss T0.
    const lateWake = dryRun("seadrop_public", { ...base, qstashLate: 58_000, coldStart: 0, setup: 1500, privySign: 800 });
    expect(lateWake.prepStart).toBe(-2000);
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
