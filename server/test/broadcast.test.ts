// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "pglite:memory";

vi.mock("../src/core/rpc/pool.js", () => ({
  getPool: () => ({
    broadcast: async (raw: string) => {
      if (raw === "raw-fail") throw new Error("rpc down");
      return { hash: "0xhash_" + raw, accepted: ["rpc1"], errors: [] };
    },
  }),
}));

vi.mock("../src/core/mint/receipts.js", async () => {
  const actual = await vi.importActual<any>("../src/core/mint/receipts.js");
  return { ...actual, waitForReceipt: async () => null, parseMintedTokenIds: () => [] };
});

vi.mock("../src/core/safety/safety.js", async () => {
  const actual = await vi.importActual<any>("../src/core/safety/safety.js");
  return {
    ...actual,
    recordSpend: async (_u: string, _c: any, _w: bigint, ref: string) => {
      if (String(ref).endsWith(":w-fail-spend")) throw new Error("db spend down");
    },
    settleSpend: async () => {},
    assertDailyBudget: async () => {},
  };
});

describe("broadcastAndTrack isolation", () => {
  beforeAll(async () => {
    const { ensureDb } = await import("../src/db/client.js");
    await ensureDb();
    const { getDb } = await import("../src/db/client.js");
    const { users } = await import("../src/db/schema.js");
    const now = new Date().toISOString();
    await getDb()
      .insert(users)
      .values({ id: "ubc", privyUserId: "did:bc", email: null, name: null, role: "user", disabled: false, createdAt: now, lastSeenAt: now })
      .onConflictDoNothing();
  });

  it("one wallet failure does not drop another wallet's txHash; spend errors still broadcast", async () => {
    const { broadcastAndTrack } = await import("../src/core/mint/executor.js");
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const job = await insertJob(
      "ubc",
      {
        chain: "base",
        contract: "0x" + "1".repeat(40),
        strategy: "seadrop_public",
        wallets: [
          { walletId: "w-ok", quantity: 1 },
          { walletId: "w-fail-spend", quantity: 1 },
          { walletId: "w-fail-bcast", quantity: 1 },
        ],
        runAt: null,
      } as any,
      {},
    );
    const results = [
      { walletId: "w-ok", address: "0xa", quantity: 1, status: "signed" as const },
      { walletId: "w-fail-spend", address: "0xb", quantity: 1, status: "signed" as const },
      { walletId: "w-fail-bcast", address: "0xc", quantity: 1, status: "signed" as const },
    ];
    const prepared = [
      { walletId: "w-ok", address: "0xa", quantity: 1, raw: "raw-ok", hash: "", reserveRef: `${job.id}:w-ok`, reserveWei: 1n },
      {
        walletId: "w-fail-spend",
        address: "0xb",
        quantity: 1,
        raw: "raw-spend",
        hash: "",
        reserveRef: `${job.id}:w-fail-spend`,
        reserveWei: 1n,
      },
      {
        walletId: "w-fail-bcast",
        address: "0xc",
        quantity: 1,
        raw: "raw-fail",
        hash: "",
        reserveRef: `${job.id}:w-fail-bcast`,
        reserveWei: 1n,
      },
    ];
    await broadcastAndTrack(
      job as any,
      { chain: "base", contract: "0x" + "1".repeat(40), strategy: "seadrop_public", wallets: [] } as any,
      prepared as any,
      results as any,
      1,
    );
    expect(results[0]!.txHash).toBe("0xhash_raw-ok");
    expect(results[0]!.status).toMatch(/broadcast|timeout/);
    expect(results[1]!.txHash).toBe("0xhash_raw-spend");
    expect(results[2]!.status).toBe("failed");
    expect(results[2]!.txHash).toBeUndefined();
    const saved = (await getJob(null, job.id))!;
    expect(saved.results.filter((r: any) => r.txHash).length).toBeGreaterThanOrEqual(2);
  });
});
