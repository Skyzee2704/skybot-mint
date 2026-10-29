// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, beforeAll } from "vitest";
import { createHash, createHmac } from "node:crypto";

process.env.DATABASE_URL = "pglite:memory";
process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_current_" + "a".repeat(20);
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_next_" + "b".repeat(20);
delete process.env.QSTASH_TOKEN;

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function qstashJwt(key: string, url: string, body: string, expOffset = 300) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      exp: now + expOffset,
      nbf: now - 1,
      iat: now,
      jti: "x",
      body: createHash("sha256").update(body).digest("base64url"),
    }),
  );
  const s = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

describe("QStash signature verification", () => {
  it("accepts current and next keys, rejects forged/tampered/wrong-url", async () => {
    const { verifyQStash } = await import("../src/jobs/qstash.js");
    const url = "https://skybot.example/api/jobs/run";
    const body = JSON.stringify({ jobId: "j1" });
    expect(await verifyQStash(qstashJwt(process.env.QSTASH_CURRENT_SIGNING_KEY!, url, body), body, url)).toBe(true);
    expect(await verifyQStash(qstashJwt(process.env.QSTASH_NEXT_SIGNING_KEY!, url, body), body, url)).toBe(true);
    expect(await verifyQStash(qstashJwt("attacker-key", url, body), body, url)).toBe(false);
    expect(await verifyQStash(qstashJwt(process.env.QSTASH_CURRENT_SIGNING_KEY!, url, body), JSON.stringify({ jobId: "j2" }), url)).toBe(
      false,
    );
    expect(await verifyQStash(qstashJwt(process.env.QSTASH_CURRENT_SIGNING_KEY!, "https://evil/x", body), body, url)).toBe(false);
    expect(await verifyQStash(null, body, url)).toBe(false);
  });
});

describe("Postgres path (PGlite) + job idempotency", () => {
  beforeAll(async () => {
    const { ensureDb, dbMode } = await import("../src/db/client.js");
    expect(dbMode()).toBe("pglite");
    await ensureDb();
    const { getDb } = await import("../src/db/client.js");
    const { users } = await import("../src/db/schema.js");
    const now = new Date().toISOString();
    await getDb()
      .insert(users)
      .values([
        { id: "ua", privyUserId: "did:a", email: "a@x", name: null, role: "user", disabled: false, createdAt: now, lastSeenAt: now },
        { id: "ub", privyUserId: "did:b", email: "b@x", name: null, role: "user", disabled: false, createdAt: now, lastSeenAt: now },
      ]);
  });

  const req = (runAt: string) =>
    ({
      chain: "base",
      contract: "0x" + "1".repeat(40),
      strategy: "seadrop_public",
      wallets: [{ walletId: "w", quantity: 1 }],
      runAt,
    }) as any;

  it("claim is atomic: only one of N concurrent claims wins; replays are skipped", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { claimJob, runJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ua", req(new Date(Date.now() + 3600_000).toISOString()), {});
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimJob(j.id)));
    expect(claims.filter(Boolean).length).toBe(1);
    expect((await getJob(null, j.id))!.status).toBe("running");
    expect((await runJob(j.id)).status).toBe("skipped");
  });

  it("cancel vs run race: cancelled job is never run; other users can't see/cancel it", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { cancelJob, claimJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ua", req(new Date(Date.now() + 3600_000).toISOString()), {});
    expect(await getJob("ub", j.id)).toBeNull();
    await expect(cancelJob("ub", j.id)).rejects.toThrow(/not found/);
    await cancelJob("ua", j.id);
    expect(await claimJob(j.id)).toBeNull();
  });

  it("runJob without signing configured fails cleanly (no broadcast)", async () => {
    delete process.env.PRIVY_AUTH_PRIVATE_KEY;
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { runJob } = await import("../src/jobs/scheduler.js");
    const j = await insertJob("ua", req(new Date(Date.now() - 1000).toISOString()), {});
    expect((await runJob(j.id, 30_000)).status).toBe("failed");
    expect((await getJob(null, j.id))!.error).toMatch(/signing key not configured/i);
  });

  it("housekeeping fails missed jobs and purges expired link codes", async () => {
    const { insertJob, getJob } = await import("../src/core/jobs/repo.js");
    const { housekeeping } = await import("../src/jobs/scheduler.js");
    const { getDb } = await import("../src/db/client.js");
    const { telegramLinks } = await import("../src/db/schema.js");
    const j = await insertJob("ub", req(new Date(Date.now() - 10 * 60_000).toISOString()), {});
    await getDb()
      .insert(telegramLinks)
      .values({ code: "old", userId: "ua", expiresAt: new Date(Date.now() - 1000).toISOString(), metaJson: "{}" });
    const r = await housekeeping();
    expect(r.missed).toBeGreaterThanOrEqual(1);
    expect(r.purgedCodes).toBe(1);
    expect((await getJob(null, j.id))!.status).toBe("failed");
  });

  it("link codes are single-use on Postgres too", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "SkymintsBOT";
    const { createTelegramLinkCode, consumeTelegramLink } = await import("../src/users/service.js");
    const { code } = await createTelegramLinkCode("ub");
    expect((await consumeTelegramLink(code, "777", null)).telegramUserId).toBe("777");
    await expect(consumeTelegramLink(code, "777", null)).rejects.toThrow();
  });
});

describe("in-memory rate limit", () => {
  it("blocks after the limit", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const { rateLimit } = await import("../src/util/ratelimit.js");
    for (let i = 0; i < 3; i++) await rateLimit("k1", 3);
    await expect(rateLimit("k1", 3)).rejects.toThrow(/Rate limit/);
  });
});
