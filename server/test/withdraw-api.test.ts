// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "b".repeat(48);
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

let app: any;
let signSession: (id: string) => { token: string };
const now = () => new Date().toISOString();

beforeAll(async () => {
  const client = await import("../src/db/client.js");
  await client.ensureDb();
  const db = client.getDb();
  const schema = await import("../src/db/schema.js");
  for (const id of ["alice", "bob"])
    await db.insert(schema.users).values({
      id,
      privyUserId: `did:privy:${id}`,
      email: null,
      name: null,
      role: "user",
      disabled: false,
      telegramUserId: null,
      telegramUsername: null,
      createdAt: now(),
      lastSeenAt: now(),
    });
  await db.insert(schema.wallets).values({
    id: "bob-w",
    userId: "bob",
    privyWalletId: "p",
    address: "0x000000000000000000000000000000000000bEEF",
    label: "bob",
    source: "privy",
    isMain: true,
    createdAt: now(),
  });
  ({ signSession } = await import("../src/auth/session.js"));
  app = await (await import("../src/api/server.js")).buildServer();
});
afterAll(async () => app?.close());

const post = (url: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: { cookie: `sb_session=${encodeURIComponent(signSession("alice").token)}`, "x-skybot-csrf": "1" },
  });

describe("withdraw API scoping + validation", () => {
  it("requires auth", async () => {
    const r = await app.inject({ method: "POST", url: "/api/withdraw/quote", payload: {} });
    expect(r.statusCode).toBe(401);
  });
  it("blocks the zero address and bad checksums", async () => {
    const z = await post("/api/withdraw/quote", {
      chain: "base",
      to: "0x0000000000000000000000000000000000000000",
      wallets: [{ walletId: "x", amount: "max" }],
    });
    expect(z.statusCode).toBe(400);
    const c = await post("/api/withdraw/quote", {
      chain: "base",
      to: "0x668b4B1631c9cE86175Af9ED7ac344f0f79927A0",
      wallets: [{ walletId: "x", amount: "max" }],
    });
    expect(c.statusCode).toBe(400);
  });
  it("cannot quote or send from another user's wallet", async () => {
    const q = await post("/api/withdraw/quote", {
      chain: "base",
      to: "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0",
      wallets: [{ walletId: "bob-w", amount: "max" }],
    });
    expect(q.statusCode).toBe(404);
    const s = await post("/api/withdraw/send", {
      chain: "base",
      walletId: "bob-w",
      tx: {
        type: 0,
        chainId: 8453,
        to: "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0",
        value: "0x1",
        nonce: 0,
        gasLimit: "0x5208",
        gasPrice: "0x1",
        data: "0x",
      },
      quoteToken: "1.x",
      signed: "0x" + "00".repeat(65),
    });
    expect(s.statusCode).toBe(404);
  });
});
