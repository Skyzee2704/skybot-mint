// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "a".repeat(48);
process.env.TELEGRAM_USER_ID = "5146984384";
process.env.ADMIN_TELEGRAM_IDS = "";
process.env.ADMIN_EMAILS = "boss@example.com";
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

let svc: typeof import("../src/users/service.js");
let schema: typeof import("../src/db/schema.js");
let db: any;
let app: any;
let signSession: (id: string) => { token: string };
const now = () => new Date().toISOString();
const cookie = (id: string) => ({ cookie: `sb_session=${encodeURIComponent(signSession(id).token)}` });

async function seed(id: string, role: string, telegramUserId: string | null, email: string | null) {
  await db.insert(schema.users).values({
    id,
    privyUserId: `did:privy:${id}`,
    email,
    name: null,
    role,
    disabled: false,
    telegramUserId,
    telegramUsername: null,
    createdAt: now(),
    lastSeenAt: now(),
  });
}

beforeAll(async () => {
  const client = await import("../src/db/client.js");
  await client.ensureDb();
  db = client.getDb();
  schema = await import("../src/db/schema.js");
  svc = await import("../src/users/service.js");
  ({ signSession } = await import("../src/auth/session.js"));
  const { buildServer } = await import("../src/api/server.js");
  app = await buildServer();
});
afterAll(async () => app?.close());

describe("admin allow-list", () => {
  it("only allow-listed Telegram ids / emails are admins", () => {
    expect(svc.isAdminIdentity({ telegramUserId: "5146984384" })).toBe(true);
    expect(svc.isAdminIdentity({ email: "Boss@Example.com" })).toBe(true);
    expect(svc.isAdminIdentity({ telegramUserId: "42" })).toBe(false);
    expect(svc.isAdminIdentity({ email: "someone@example.com" })).toBe(false);
    expect(svc.isAdminIdentity({})).toBe(false);
  });

  it("the very first user is NOT auto-promoted", async () => {
    const rows = await db.select().from(schema.users);
    expect(rows).toHaveLength(0);
    const u = await svc.resolvePrivyUser("did:privy:first", { email: "first@example.com" });
    expect(u.role).toBe("user");
    const t = await svc.upsertTelegramFirstUser({ id: 777 });
    expect(t.user.role).toBe("user");
    const owner = await svc.upsertTelegramFirstUser({ id: 5146984384 });
    expect(owner.user.role).toBe("admin");
  });

  it("a stale stored admin role is ignored and demoted on the next request", async () => {
    await seed("stale", "admin", "999", null);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: cookie("stale") });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe("user");
    const r = await app.inject({ method: "GET", url: "/api/admin/users", headers: cookie("stale") });
    expect(r.statusCode).toBe(403);
    const row = (await db.select().from(schema.users)).find((x: any) => x.id === "stale");
    expect(row.role).toBe("user");
  });

  it("every /api/admin/* route rejects non-admins server-side", async () => {
    await seed("plain", "user", "123", "plain@example.com");
    const h = { ...cookie("plain"), "x-skybot-csrf": "1" };
    for (const [method, url] of [
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/telegram/setup"],
      ["POST", "/api/admin/users/stale/disable"],
    ] as const) {
      const r = await app.inject({ method, url, headers: h, payload: method === "POST" ? { disabled: true } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    const stale = (await db.select().from(schema.users)).find((x: any) => x.id === "stale");
    expect(stale.disabled).toBe(false);
  });

  it("allow-listed owner (Telegram) and email admin get access", async () => {
    await seed("owner2", "user", null, "boss@example.com");
    const r = await app.inject({ method: "GET", url: "/api/admin/users", headers: cookie("owner2") });
    expect(r.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: cookie("owner2") });
    expect(me.json().user.role).toBe("admin");
  });
});
