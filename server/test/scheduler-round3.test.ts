// SPDX-License-Identifier: AGPL-3.0-only
/**
 * F-N4 (round 3): a job with no wallets must never be created, and a 0-wallet job that
 * already exists must fail fast with a reason — never wait for fireAt and end "done"
 * for 0 of 0 wallets. enqueueMint + runJob guards, with the DB layer mocked.
 */
import { describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  insertJob: vi.fn(),
  getJob: vi.fn(),
  claimJob: vi.fn(),
  patchRunningJob: vi.fn(async () => true),
  patchJob: vi.fn(async () => {}),
  jobStatus: vi.fn(async () => "running"),
  appendJobLog: vi.fn(async () => {}),
  listActiveJobs: vi.fn(async () => []),
  patchJobIfStatus: vi.fn(async () => true),
  beginBroadcast: vi.fn(async () => true),
  recordMinted: vi.fn(async () => {}),
}));
class JobCancelledError extends Error {}

vi.mock("../src/core/jobs/repo.js", () => ({ ...repo, JobCancelledError }));
vi.mock("../src/db/client.js", () => ({
  // claimJob (defined in scheduler.ts) is the only DB touch on the guard path: stub the
  // drizzle update chain so the claim succeeds without a database.
  getDb: () => ({
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "job-0" }] }) }) }),
  }),
}));
vi.mock("../src/db/schema.js", () => ({ jobs: {}, telegramLinks: {} }));
vi.mock("../src/core/mint/executor.js", () => ({
  prepareAll: vi.fn(),
  broadcastAndTrack: vi.fn(),
  trackReceipts: vi.fn(),
  mapLimit: async (items: any[], _n: number, fn: any) => {
    for (const [i, x] of items.entries()) await fn(x, i);
  },
  waitUntil: async () => {},
  warmMint: async () => {},
  OPENSEA_LEAD_MS: 150,
}));
vi.mock("../src/util/keepalive.js", () => ({ installKeepAlive: () => {}, warmSockets: async () => {}, WARM_HOSTS: [] }));
vi.mock("../src/bot/notify.js", () => ({ notifyJobDone: vi.fn(async () => {}) }));
vi.mock("../src/config/chains.js", async () => {
  const a = await vi.importActual<any>("../src/config/chains.js");
  return { ...a, getChain: () => null, rpcsForChain: () => ({ send: [] }) };
});
vi.mock("../src/core/rpc/pool.js", () => ({ getPool: () => ({ rankLatency: async () => {} }) }));
vi.mock("../src/util/log.js", () => ({ log: { info: () => {}, warn: () => {}, error: () => {} }, redactString: (s: string) => s }));

describe("F-N4: zero-wallet jobs", () => {
  it("enqueueMint refuses an empty wallet list before touching the DB", async () => {
    const { enqueueMint } = await import("../src/jobs/scheduler.js");
    repo.insertJob.mockClear();
    await expect(
      enqueueMint("u", { chain: "sim", contract: "0x" + "c".repeat(40), strategy: "opensea_api", wallets: [] } as any, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.insertJob).not.toHaveBeenCalled();
  });

  it("enqueueMint still creates a job with wallets", async () => {
    const { enqueueMint } = await import("../src/jobs/scheduler.js");
    const job = { id: "job-1", userId: "u", status: "scheduled", request: { wallets: [{ walletId: "w0", quantity: 1 }] } };
    repo.insertJob.mockResolvedValueOnce(job);
    repo.getJob.mockResolvedValueOnce(job);
    const out = await enqueueMint(
      "u",
      { chain: "sim", contract: "0x" + "c".repeat(40), strategy: "opensea_api", wallets: [{ walletId: "w0", quantity: 1 }] } as any,
      {},
    );
    expect(out.id).toBe("job-1");
    expect(repo.insertJob).toHaveBeenCalledTimes(1);
  });

  it("runJob fails a 0-wallet job at once (no waiting for fireAt, no broadcast claim)", async () => {
    const { runJob } = await import("../src/jobs/scheduler.js");
    const { notifyJobDone } = await import("../src/bot/notify.js");
    const job = {
      id: "job-0",
      userId: "u",
      status: "scheduled",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: null,
      broadcastAt: null,
      chain: "sim",
      target: "0x" + "c".repeat(40),
      strategy: "opensea_api",
      request: { chain: "sim", contract: "0x" + "c".repeat(40), strategy: "opensea_api", wallets: [] },
      results: [],
      log: [],
    };
    repo.getJob.mockResolvedValue(job);
    repo.claimJob.mockResolvedValue(job);
    repo.patchRunningJob.mockClear();
    (notifyJobDone as any).mockClear?.();
    const out = await runJob("job-0", 300_000);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("no wallets");
    expect(repo.patchRunningJob).toHaveBeenCalledWith(
      "job-0",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("no wallets") }),
    );
    expect(notifyJobDone).toHaveBeenCalledWith("job-0");
    expect(repo.beginBroadcast).not.toHaveBeenCalled();
  });
});
