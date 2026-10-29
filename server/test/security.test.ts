// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

describe("telegram initData HMAC", () => {
  const token = "123456:ABC-DEF";
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = token;
  });

  function sign(fields: Record<string, string>) {
    const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const q = new URLSearchParams({ ...fields, hash });
    return q.toString();
  }

  it("accepts valid initData and rejects forged hash", async () => {
    const { validateInitData } = await import("../src/bot/telegramWebApp.js");
    const user = JSON.stringify({ id: 42, username: "alice" });
    const auth_date = String(Math.floor(Date.now() / 1000));
    const good = sign({ user, auth_date });
    const v = validateInitData(good);
    expect(v.user.id).toBe(42);

    const bad = good.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
    expect(() => validateInitData(bad)).toThrow(/Invalid/);
  });

  it("rejects expired auth_date", async () => {
    const { validateInitData } = await import("../src/bot/telegramWebApp.js");
    const user = JSON.stringify({ id: 1 });
    const auth_date = String(Math.floor(Date.now() / 1000) - 100_000);
    const old = sign({ user, auth_date });
    expect(() => validateInitData(old, 60)).toThrow(/expired/i);
  });
});

describe("link codes single-use + isolation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skybot-sec-"));
  beforeAll(() => {
    process.env.DATA_DIR = dataDir;
    process.env.TELEGRAM_BOT_USERNAME = "SkymintsBOT";
    delete process.env.DATABASE_URL;
  });
  afterAll(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("web→tg deep link uses link_ prefix and consume is single-use", async () => {
    const { ensureDb } = await import("../src/db/client.js");
    await ensureDb();
    const { getDb } = await import("../src/db/client.js");
    const { users } = await import("../src/db/schema.js");
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u1",
      privyUserId: "did:privy:u1",
      email: "a@test.com",
      name: null,
      role: "user",
      disabled: false,
      createdAt: now,
      lastSeenAt: now,
    });
    const { createTelegramLinkCode, consumeTelegramLink } = await import("../src/users/service.js");
    const { code, deepLink } = await createTelegramLinkCode("u1");
    expect(deepLink).toContain("start=link_");
    expect(deepLink).toContain(code);
    const u = await consumeTelegramLink(code, "999", "bob");
    expect(u.telegramUserId).toBe("999");
    await expect(consumeTelegramLink(code, "999", "bob")).rejects.toThrow(/Invalid|expired/i);
  });

  it("plans cannot be consumed cross-user", async () => {
    const { createPlan, consumePlan } = await import("../src/core/plans.js");
    const p = createPlan("alice", "mint", { n: 1 }, "MINT 1");
    expect(() => consumePlan("eve", p.id, "mint", "MINT 1")).toThrow(/another user/);
  });
});

describe("server refuses raw key import", () => {
  it("importPrivyWallet throws client-only", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_SERVER_KEY_IMPORT;
    const { importPrivyWallet } = await import("../src/auth/privy.js");
    await expect(importPrivyWallet("did:x", "0x" + "11".repeat(32))).rejects.toThrow(/disabled|browser|client/i);
  });
});

describe("log redaction", () => {
  it("masks private keys and JWTs", async () => {
    const { redactString } = await import("../src/util/log.js");
    const pk = "0x" + "ab".repeat(32);
    expect(redactString(`key=${pk}`)).not.toContain("abab");
    expect(redactString("eyJhbGciOiJIUzI1NiJ9.e30.sig")).toContain("REDACTED_JWT");
  });
});

describe("telegram webhook requires secret", () => {
  it("returns 404 when not in webhook mode / no secret", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { buildServer } = await import("../src/api/server.js");
    const app = await buildServer();
    const r = await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: {} });
    expect(r.statusCode).toBe(404);
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret-value";
    const r2 = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      payload: {},
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });
    expect(r2.statusCode).toBe(401);
    const r3 = await app.inject({ method: "POST", url: "/api/wallets/import", payload: { key: "0x00" } });
    expect(r3.statusCode).toBe(401);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    await app.close();
  });
});

describe("telegram-first session", () => {
  it("signs/verifies and rejects tampering + expiry", async () => {
    process.env.SESSION_SECRET = "x".repeat(48);
    const { signSession, verifySession } = await import("../src/auth/session.js");
    const { token } = signSession("user-1");
    expect(verifySession(token)).toBe("user-1");
    const [v, , exp, sig] = token.split(".");
    expect(verifySession(`${v}.${Buffer.from("admin").toString("base64url")}.${exp}.${sig}`)).toBeNull();
    expect(verifySession(signSession("user-1", -5).token)).toBeNull();
  });

  it("cookie writes require CSRF header; session endpoint rejects forged initData", async () => {
    process.env.SESSION_SECRET = "x".repeat(48);
    const { buildServer } = await import("../src/api/server.js");
    const { signSession } = await import("../src/auth/session.js");
    const app = await buildServer();
    const cookie = `sb_session=${encodeURIComponent(signSession("u1").token)}`;
    const r = await app.inject({ method: "POST", url: "/api/telegram/unlink", headers: { cookie }, payload: {} });
    expect(r.statusCode).toBe(403);
    const f = await app.inject({
      method: "POST",
      url: "/api/telegram/session",
      payload: { initData: "user=%7B%22id%22%3A1%7D&auth_date=9999999999&hash=" + "0".repeat(64) },
    });
    expect(f.statusCode).toBe(401);
    await app.close();
  });
});
