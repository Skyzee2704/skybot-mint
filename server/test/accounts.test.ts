// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

type Svc = typeof import("../src/users/service.js");
let svc: Svc;
let db: any;
let schema: typeof import("../src/db/schema.js");
const now = () => new Date().toISOString();

async function seedUser(id: string, privyUserId: string, telegramUserId: string | null = null, email: string | null = null) {
  await db.insert(schema.users).values({
    id,
    privyUserId,
    email,
    name: null,
    role: "user",
    disabled: false,
    telegramUserId,
    telegramUsername: telegramUserId ? `tg${telegramUserId}` : null,
    createdAt: now(),
    lastSeenAt: now(),
  });
}

async function seedWallet(userId: string, address: string) {
  await db.insert(schema.wallets).values({
    id: `w-${userId}-${address.slice(-4)}`,
    userId,
    privyWalletId: `pw-${userId}`,
    address,
    label: "w",
    source: "privy",
    isMain: true,
    createdAt: now(),
  });
}

beforeAll(async () => {
  const client = await import("../src/db/client.js");
  await client.ensureDb();
  db = client.getDb();
  schema = await import("../src/db/schema.js");
  svc = await import("../src/users/service.js");
});

describe("unified Privy account resolution", () => {
  it("parallel first-login requests resolve to one account (no unique-constraint 401)", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.resolvePrivyUser("did:privy:race", { email: "Race@Test.com" })));
    expect(new Set(results.map((u) => u.id)).size).toBe(1);
    const rows = await db.select().from(schema.users);
    expect(rows.filter((r: any) => r.privyUserId === "did:privy:race")).toHaveLength(1);
    expect(results[0].email).toBe("race@test.com");
  });

  it("Privy Telegram login lands in the existing Telegram-first (local) account", async () => {
    await seedUser("tg-local", "tg:1001", "1001");
    const u = await svc.resolvePrivyUser("did:privy:tg1001", { telegram: { id: "1001", username: "alice" } });
    expect(u.id).toBe("tg-local");
    expect(u.privyUserId).toBe("did:privy:tg1001");
    // Later requests (no profile) still resolve by Privy id.
    expect((await svc.resolvePrivyUser("did:privy:tg1001")).id).toBe("tg-local");
  });

  it("attaches to a Privy-backed Telegram account that owns no wallets", async () => {
    await seedUser("tg-empty", "did:privy:old-empty", "1002");
    const u = await svc.resolvePrivyUser("did:privy:new-1002", { telegram: { id: "1002" } });
    expect(u.id).toBe("tg-empty");
    expect(u.privyUserId).toBe("did:privy:new-1002");
  });

  it("refuses to merge when the Telegram account belongs to another Privy user with wallets", async () => {
    await seedUser("tg-owner", "did:privy:owner", "1003");
    await seedWallet("tg-owner", "0x000000000000000000000000000000000000dEaD");
    await expect(svc.resolvePrivyUser("did:privy:intruder", { telegram: { id: "1003" } })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCOUNT_CONFLICT",
    });
    const owner = (await db.select().from(schema.users)).find((r: any) => r.id === "tg-owner");
    expect(owner.privyUserId).toBe("did:privy:owner");
    expect((await db.select().from(schema.users)).some((r: any) => r.privyUserId === "did:privy:intruder")).toBe(false);
  });

  it("new Privy users with a linked Telegram get it recorded; existing users get it attached when free", async () => {
    const fresh = await svc.resolvePrivyUser("did:privy:fresh", { telegram: { id: "1004", username: "bob" } });
    expect(fresh.telegramUserId).toBe("1004");
    await seedUser("email-only", "did:privy:email-only", null, "e@test.com");
    const linked = await svc.resolvePrivyUser("did:privy:email-only", { telegram: { id: "1005" } });
    expect(linked.id).toBe("email-only");
    expect(linked.telegramUserId).toBe("1005");
  });

  it("never steals a Telegram id already held by another account", async () => {
    await seedUser("holder", "did:privy:holder", "1006");
    await seedUser("other", "did:privy:other");
    const u = await svc.resolvePrivyUser("did:privy:other", { telegram: { id: "1006" } });
    expect(u.telegramUserId).toBeNull();
  });

  it("parallel Mini App opens create one Telegram-first account", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.upsertTelegramFirstUser({ id: 2001, username: "carol" })));
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBeLessThanOrEqual(1);
  });

  it("attach-privy refuses to re-point an account whose wallets belong to its current Privy user", async () => {
    await expect(svc.attachPrivyToUser("tg-owner", "did:privy:email-login", { email: "x@test.com" })).rejects.toMatchObject({
      code: "ACCOUNT_CONFLICT",
    });
  });
});

describe("profileFromPrivyUser", () => {
  it("extracts email, Google and numeric Telegram id only", () => {
    const p = svc.profileFromPrivyUser({
      linked_accounts: [
        { type: "google_oauth", email: "g@test.com", name: "G" },
        { type: "telegram", telegram_user_id: "987654321", username: "tguser" },
      ],
    });
    expect(p).toEqual({ email: "g@test.com", name: "G", telegram: { id: "987654321", username: "tguser" } });
    expect(svc.profileFromPrivyUser({ linked_accounts: [{ type: "telegram", telegram_user_id: "opaque-sub-xyz" }] }).telegram).toBeNull();
    expect(svc.profileFromPrivyUser(null)).toEqual({ email: null, name: null, telegram: null });
  });
});
