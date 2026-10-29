// SPDX-License-Identifier: AGPL-3.0-only
/** Job cancellation: owner/admin scope, allowed states, races with claim / broadcast, runner re-checks. */
import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
delete process.env.QSTASH_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;

const hooks = vi.hoisted(() => ({
  prepareAll: vi.fn(async (_job: any, req: any) => ({ prepared: [], results: req.wallets.map((w: any) => ({ ...w, status: "signed" })) })),
  broadcastAndTrack: vi.fn(async () => {}),
}));

vi.mock("../src/config/env.js", async (orig) => ({ ...(await orig<any>()), privyServerSigningReady: () => true }));
vi.mock("../src/users/mintSigner.js", async (orig) => ({
  ...(await orig<any>()),
  mintSignerDiag: async () => ({ keyReadable: true, keyInQuorum: true }),
}));
vi.mock("../src/core/mint/executor.js", async (orig) => ({
  ...(await orig<any>()),
  prepareAll: hooks.prepareAll,
  broadcastAndTrack: hooks.broadcastAndTrack,
}));

const req = (runAt: string | null) =>
  ({
    chain: "base",
    contract: "0x" + "1".repeat(40),
    strategy: "seadrop_public",
    wallets: [{ walletId: "w", quantity: 1 }],
    runAt,
  }) as any;
const later = () => new Date(Date.now() + 3600_000).toISOString();

describe("job cancellation", () => {
  beforeAll(async () => {
    const { ensureDb, getDb } = await import("../src/db/client.js");
    await ensureDb();
    const { users } = await import("../src/db/schema.js");
    const now = new Date().toISOString();
    await getDb()
      .insert(users)
      .values([
        { id: "ca", privyUserId: "did:ca", email: "ca@x", name: null, role: "user", disabled: false, createdAt: now, lastSeenAt: now },
        { id: "cb", privyUserId: "did:cb", email: "cb@x", name: null, role: "user", disabled: false, createdAt: now, lastSeenAt: now },
      ]);
  });
  beforeEach(() => {
    hooks.prepareAll.mockClear();
    hooks.broadcastAndTrack.mockClear();
  });

  it("cancels a pending job, logs it, and a later QStash delivery is a no-op", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, runJob, housekeeping } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ca", req(new Date(Date.now() - 10 * 60_000).toISOString()), {});
    const c = await cancelJob("ca", j.id);
    expect(c.status).toBe("cancelled");
    expect(c.error).toMatch(/cancelled by owner/i);
    expect(c.log.some((l) => /cancelled by owner/.test(l))).toBe(true);
    expect(await runJob(j.id, 30_000)).toEqual({ status: "skipped", reason: "status cancelled" });
    await housekeeping(); // missed-start sweep must not touch a cancelled job
    expect((await getJob(null, j.id))!.status).toBe("cancelled");
    expect(hooks.prepareAll).not.toHaveBeenCalled();
  });

  it("cannot cancel another user's job (404); an admin can", async () => {
    const { insertJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ca", req(later()), {});
    await expect(cancelJob("cb", j.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(cancelJob({ id: "cb", admin: false }, j.id)).rejects.toMatchObject({ statusCode: 404 });
    const c = await cancelJob({ id: "cb", admin: true }, j.id);
    expect(c.status).toBe("cancelled");
    expect(c.error).toMatch(/cancelled by admin/i);
  });

  it("cannot cancel a completed, failed, already-cancelled or broadcast job (409)", async () => {
    const { insertJob, patchJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, claimJob, ALREADY_SENT_MESSAGE } = await import("../src/jobs/scheduler.js");
    const { beginBroadcast } = await import("../src/core/jobs/repo.js");
    for (const status of ["done", "failed", "cancelled"] as const) {
      const j = await insertJob("ca", req(later()), {});
      await patchJob(j.id, { status });
      await expect(cancelJob("ca", j.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await getJob(null, j.id))!.status).toBe(status);
    }
    const b = await insertJob("ca", req(later()), {});
    await claimJob(b.id);
    expect(await beginBroadcast(b.id)).toBe(true);
    await expect(cancelJob("ca", b.id)).rejects.toThrow(ALREADY_SENT_MESSAGE);
    expect((await getJob(null, b.id))!.status).toBe("running");
  });

  it("cancel racing the runner's claim: always ends cancelled, and broadcast can no longer start", async () => {
    const { insertJob, getJob, beginBroadcast } = await import("../src/core/jobs/repo.js");
    const { cancelJob, claimJob } = await import("../src/jobs/scheduler.js");
    for (let i = 0; i < 5; i++) {
      const j = await insertJob("ca", req(later()), {});
      const [, claim] = await Promise.allSettled([cancelJob("ca", j.id), claimJob(j.id)]);
      expect((await getJob(null, j.id))!.status).toBe("cancelled");
      // Whether the claim won or not, the cancel holds and the broadcast gate stays shut.
      expect(claim.status).toBe("fulfilled");
      expect(await beginBroadcast(j.id)).toBe(false);
    }
  });

  it("cancel vs broadcast gate: exactly one wins", async () => {
    const { insertJob, getJob, beginBroadcast } = await import("../src/core/jobs/repo.js");
    const { cancelJob, claimJob } = await import("../src/jobs/scheduler.js");
    for (let i = 0; i < 5; i++) {
      const j = await insertJob("ca", req(later()), {});
      await claimJob(j.id);
      const [c, g] = await Promise.allSettled([cancelJob("ca", j.id), beginBroadcast(j.id)]);
      const cancelled = c.status === "fulfilled";
      const broadcast = g.status === "fulfilled" && g.value === true;
      expect(cancelled !== broadcast).toBe(true);
      expect((await getJob(null, j.id))!.status).toBe(cancelled ? "cancelled" : "running");
    }
  });

  it("cancel during the pre-sign wait stops the runner before signing", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, runJob } = await import("../src/jobs/scheduler.js");
    // Pre-sign starts 3 s before runAt → ~3 s of waiting here.
    const j = await insertJob("ca", req(new Date(Date.now() + 6000).toISOString()), {});
    const t0 = Date.now();
    const run = runJob(j.id, 60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect((await getJob(null, j.id))!.status).toBe("running");
    await cancelJob("ca", j.id);
    expect(await run).toEqual({ status: "skipped", reason: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(hooks.prepareAll).not.toHaveBeenCalled();
    expect(hooks.broadcastAndTrack).not.toHaveBeenCalled();
    const after = (await getJob(null, j.id))!;
    expect(after.status).toBe("cancelled");
    expect(after.broadcastAt).toBeNull();
    expect(after.log.some((l) => /runner stopped/.test(l))).toBe(true);
  });

  it("cancel while signing: signed txs are discarded at the broadcast gate", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, runJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ca", req(null), {}); // Mint Now: no pre-sign wait
    hooks.prepareAll.mockImplementationOnce(async (job: any, r: any) => {
      await cancelJob("ca", job.id);
      return { prepared: [], results: r.wallets.map((w: any) => ({ ...w, status: "signed" })) };
    });
    expect(await runJob(j.id, 60_000)).toEqual({ status: "skipped", reason: "cancelled" });
    expect(hooks.prepareAll).toHaveBeenCalledTimes(1);
    expect(hooks.broadcastAndTrack).not.toHaveBeenCalled();
    expect((await getJob(null, j.id))!.status).toBe("cancelled");
  });

  it("a runner failure after a cancel does not overwrite the cancel", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, runJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ca", req(null), {});
    hooks.prepareAll.mockImplementationOnce(async (job: any) => {
      await cancelJob("ca", job.id);
      throw new Error("rpc exploded");
    });
    expect((await runJob(j.id, 60_000)).status).toBe("skipped");
    expect((await getJob(null, j.id))!.status).toBe("cancelled");
  });

  it("an uncancelled run still broadcasts (gate opens once)", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { runJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ca", req(null), {});
    hooks.broadcastAndTrack.mockImplementationOnce(async (_j: any, _r: any, _p: any, results: any[]) => {
      for (const r of results) r.status = "confirmed";
    });
    expect((await runJob(j.id, 60_000)).status).toBe("done");
    const after = (await getJob(null, j.id))!;
    expect(after.status).toBe("done");
    expect(after.broadcastAt).toBeTruthy();
  });
});
