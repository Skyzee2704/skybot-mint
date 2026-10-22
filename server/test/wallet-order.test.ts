// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "d".repeat(48);
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("wallet order: Main first, then oldest first", () => {
  let svc: typeof import("../src/users/service.js");
  let db: any;
  let schema: typeof import("../src/db/schema.js");
  beforeAll(async () => {
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    db = client.getDb();
    schema = await import("../src/db/schema.js");
    const t = new Date().toISOString();
    await db.insert(schema.users).values({ id: "mu", privyUserId: "did:privy:mu", role: "user", disabled: false, createdAt: t, lastSeenAt: t });
    svc = await import("../src/users/service.js");
    const rows = [
      { id: "w-1", createdAt: "2026-10-21T14:01:00.000Z" },
      { id: "w-3", createdAt: "2026-10-22T05:47:00.000Z" },
      { id: "w-2b", createdAt: "2026-10-22T04:16:00.000Z" },
      { id: "w-2a", createdAt: "2026-10-22T04:16:00.000Z" }, // same instant: id breaks the tie
      { id: "w-4", createdAt: "2026-10-22T06:19:00.000Z" },
    ];
    let n = 1;
    for (const r of rows)
      await db.insert(schema.wallets).values({
        ...r,
        userId: "mu",
        address: A(n++),
        label: r.id,
        privyWalletId: `p${r.id}`,
        source: "imported",
        isMain: r.id === "w-3",
      });
  });

  it("lists the Main wallet at the top, the rest oldest first with a stable id tiebreak", async () => {
    expect((await svc.listWallets("mu")).map((w) => w.id)).toEqual(["w-3", "w-1", "w-2a", "w-2b", "w-4"]);
    expect((await svc.walletsOverview("mu")).wallets.map((w) => w.id)).toEqual(["w-3", "w-1", "w-2a", "w-2b", "w-4"]);
  });

  it("changing Main re-sorts immediately", async () => {
    await svc.setMain("mu", "w-4");
    expect((await svc.listWallets("mu")).map((w) => w.id)).toEqual(["w-4", "w-1", "w-2a", "w-2b", "w-3"]);
  });

  it("removing Main promotes the oldest wallet, which then leads the list", async () => {
    await svc.hideWallet("mu", "w-4");
    const ids = (await svc.listWallets("mu")).map((w) => w.id);
    expect(ids).toEqual(["w-1", "w-2a", "w-2b", "w-3"]);
    expect((await svc.listWallets("mu"))[0]!.isMain).toBe(true);
  });

  it("the pure comparator matches (shared by every list)", () => {
    const ws = [
      { id: "b", isMain: false, createdAt: "2026-01-02" },
      { id: "a", isMain: false, createdAt: "2026-01-02" },
      { id: "m", isMain: true, createdAt: "2026-12-31" },
      { id: "z", isMain: false, createdAt: "2026-01-01" },
    ];
    expect(svc.sortWallets(ws).map((w) => w.id)).toEqual(["m", "z", "a", "b"]);
  });
});
