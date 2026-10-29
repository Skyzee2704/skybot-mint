// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dry-run simulation of the mint pipeline (prepareAll + streaming send). Everything external is mocked with fixed
 * latencies — OpenSea build, RPC, Privy signing, DB — so no network, no keys, no transactions. Prints simulated
 * per-wallet send drift for each path (post-start build, pre-signed, re-signed, batch fallback).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LAT = { build: 400, gas: 150, sign: 500, nonce: 60 };
const sim = vi.hoisted(() => ({
  fireAt: 0,
  preBuild: "409" as "409" | "same" | "different",
  price: 1n as bigint | null,
  logs: [] as string[],
  signs: 0,
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("../src/config/chains.js", async () => {
  const a = await vi.importActual<any>("../src/config/chains.js");
  return { ...a, requireChain: () => ({ key: "sim", chainId: 1, name: "Sim", nativeSymbol: "ETH" }) };
});
vi.mock("../src/core/rpc/pool.js", () => ({
  getPool: () => ({
    checkChainId: async () => {},
    read: async (fn: any, kind: string) => {
      if (kind === "nonce") return sleep(LAT.nonce).then(() => 7);
      if (kind === "estimateGas") return sleep(LAT.gas).then(() => 100_000n);
      throw new Error("unexpected read " + kind);
    },
  }),
}));
vi.mock("../src/core/resolver/cache.js", () => ({ getResolved: async () => ({ stages: [] }) }));
vi.mock("../src/core/mint/stage.js", () => ({ stagePriceWei: () => sim.price }));
vi.mock("../src/core/mint/fees.js", () => ({ getFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }) }));
vi.mock("../src/users/service.js", () => ({
  getWallet: async (_u: string, id: string) => ({ address: "0x" + id.padStart(40, "0"), privyWalletId: "pw-" + id }),
}));
vi.mock("../src/core/safety/safety.js", () => ({
  assertDailyBudget: async () => {},
  recordSpend: async () => {},
  settleSpend: async () => {},
}));
vi.mock("../src/core/jobs/repo.js", async () => {
  class JobCancelledError extends Error {}
  return {
    JobCancelledError,
    appendJobLog: async (_id: string, m: string) => void sim.logs.push(m),
    jobStatus: async () => "running",
    patchJob: async () => {},
    recordMinted: async () => {},
  };
});
vi.mock("../src/auth/privy.js", () => ({
  signRawTransaction: async (_w: string, tx: any) => {
    sim.signs++;
    await sleep(LAT.sign);
    return `raw:${tx.data}:${tx.nonce}`;
  },
}));
vi.mock("../src/core/mint/build.js", async () => {
  class MintBuildError extends Error {
    constructor(
      m: string,
      public code = "BUILD",
    ) {
      super(m);
    }
  }
  return {
    MintBuildError,
    buildMintTx: async (_t: any, _r: any, addr: string) => {
      await sleep(LAT.build);
      const open = Date.now() >= sim.fireAt;
      if (!open && sim.preBuild === "409") throw new MintBuildError("stage not active", "NOT_ACTIVE");
      const data = !open && sim.preBuild === "different" ? "0xprev" + addr.slice(-4) : "0xmint" + addr.slice(-4);
      return { to: "0x" + "a".repeat(40), data, value: 1n };
    },
  };
});

async function run(wallets = 7) {
  const { prepareAll } = await import("../src/core/mint/executor.js");
  const fireAt = Date.now() + 1500;
  sim.fireAt = fireAt;
  const sendDrift: number[] = [];
  const req: any = {
    chain: "sim",
    contract: "0x" + "c".repeat(40),
    strategy: "opensea_api",
    wallets: Array.from({ length: wallets }, (_, i) => ({ walletId: `w${i}`, quantity: 1 })),
  };
  const out = await prepareAll({ id: "job-sim", userId: "u" } as any, req, {}, fireAt + 30_000, {
    fireAt,
    buildNotBefore: fireAt,
    onSigned: async () => {
      while (Date.now() < fireAt) await sleep(1); // broadcast gate (exact start)
      sendDrift.push(Date.now() - fireAt);
    },
  });
  if (!sendDrift.length) for (const _ of out.prepared) sendDrift.push(Date.now() - fireAt); // batch fallback
  return { out, sendDrift, timing: sim.logs.find((l) => l.startsWith("prepared")) };
}

describe("mint dry-run simulation (mocked OpenSea/RPC/Privy, nothing sent)", () => {
  beforeEach(() => {
    sim.logs = [];
    sim.signs = 0;
    sim.price = 1n;
  });

  it("409 before start → post-start build/sign, streamed per wallet", async () => {
    sim.preBuild = "409";
    const r = await run();
    console.log(`[sim post-start] send drift ms: ${r.sendDrift.join(", ")}\n  ${r.timing}`);
    expect(r.out.prepared).toHaveLength(7);
    expect(Math.max(...r.sendDrift)).toBeLessThan(LAT.build + LAT.gas + LAT.sign + 600);
    expect(r.timing).toMatch(/mode stream/);
  });

  it("OpenSea builds early and the same tx after start → pre-signed tx reused (no gas/sign after start)", async () => {
    sim.preBuild = "same";
    const r = await run();
    console.log(`[sim presigned] send drift ms: ${r.sendDrift.join(", ")}\n  ${r.timing}`);
    expect(r.timing).toMatch(/presigned 7/);
    expect(sim.signs).toBe(7);
    expect(Math.max(...r.sendDrift)).toBeLessThan(LAT.build + 300);
  });

  it("early build differs from the post-start build → re-signed (pre-signed tx discarded)", async () => {
    sim.preBuild = "different";
    const r = await run();
    console.log(`[sim resigned] send drift ms: ${r.sendDrift.join(", ")}\n  ${r.timing}`);
    expect(sim.signs).toBe(14);
    expect(r.timing).toMatch(/presigned 0/);
    expect(r.out.prepared.every((p) => p.raw.startsWith("raw:0xmint"))).toBe(true);
  });

  it("price unknown up front → batch fallback (budget checked on real total before release)", async () => {
    sim.preBuild = "409";
    sim.price = null;
    const r = await run();
    console.log(`[sim batch] send drift ms: ${r.sendDrift.join(", ")}\n  ${r.timing}`);
    expect(r.timing).toMatch(/mode batch/);
    expect(r.out.prepared).toHaveLength(7);
  });
});
