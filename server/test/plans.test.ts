// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";

describe("confirm plans (DB-backed)", () => {
  beforeAll(async () => {
    const { ensureDb } = await import("../src/db/client.js");
    await ensureDb();
    const { getDb } = await import("../src/db/client.js");
    const { users } = await import("../src/db/schema.js");
    const now = new Date().toISOString();
    await getDb()
      .insert(users)
      .values({
        id: "plan-u",
        privyUserId: "did:plan",
        email: "p@x",
        name: null,
        role: "user",
        disabled: false,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing();
  });

  it("create + consume is owner-scoped and single-use", async () => {
    const { createPlan, consumePlan } = await import("../src/core/plans.js");
    const p = await createPlan("plan-u", "mint", { n: 1 }, "MINT 1");
    expect(p.id).toMatch(/^[a-f0-9]+$/);
    await expect(consumePlan("other", p.id, "mint", "MINT 1")).rejects.toThrow(/another user|not found/i);
    const got = await consumePlan("plan-u", p.id, "mint", "MINT 1");
    expect(got.data).toEqual({ n: 1 });
    await expect(consumePlan("plan-u", p.id, "mint", "MINT 1")).rejects.toThrow(/not found/i);
  });

  it("wrong phrase is rejected without consuming the plan", async () => {
    const { createPlan, consumePlan } = await import("../src/core/plans.js");
    const p = await createPlan("plan-u", "mint", { n: 2 }, "MINT 2");
    await expect(consumePlan("plan-u", p.id, "mint", "NOPE")).rejects.toThrow(/Confirmation/);
    const got = await consumePlan("plan-u", p.id, "mint", "MINT 2");
    expect(got.data).toEqual({ n: 2 });
  });
});
