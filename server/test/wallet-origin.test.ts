// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "c".repeat(48);
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("wallet origin and order", () => {
  let svc: typeof import("../src/users/service.js");
  let db: any;
  let schema: typeof import("../src/db/schema.js");
  beforeAll(async () => {
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    db = client.getDb();
    schema = await import("../src/db/schema.js");
    const t = new Date().toISOString();
    await db
      .insert(schema.users)
      .values({ id: "ou", privyUserId: "did:privy:ou", role: "user", disabled: false, createdAt: t, lastSeenAt: t });
    svc = await import("../src/users/service.js");
  });

  it("lists wallets oldest first even after rows are updated", async () => {
    const rows = [
      { id: "w-c", address: A(3), label: "third", createdAt: "2026-10-22T05:47:00.000Z" },
      { id: "w-a", address: A(1), label: "first", createdAt: "2026-10-21T14:01:00.000Z" },
      { id: "w-b", address: A(2), label: "second", createdAt: "2026-10-22T04:16:00.000Z" },
    ];
    for (const r of rows)
      await db.insert(schema.wallets).values({ ...r, userId: "ou", privyWalletId: `p${r.id}`, source: "privy", isMain: r.id === "w-a" });
    await svc.updateWallet("ou", "w-a", { label: "first (renamed)" }); // physical row moves on Postgres
    expect((await svc.listWallets("ou")).map((w) => w.id)).toEqual(["w-a", "w-b", "w-c"]);
  });

  it("an import that loses the race to the background sync still ends up Imported", async () => {
    const bg = await svc.syncPrivyWallet("ou", { privyWalletId: "pimp", address: A(9), source: "privy" });
    expect(bg.source).toBe("privy");
    const imp = await svc.syncPrivyWallet("ou", { privyWalletId: "pimp", address: A(9), label: "Mine", source: "imported", restore: true });
    expect(imp).toMatchObject({ source: "imported", label: "Mine" });
    // A later background sync never downgrades it.
    expect((await svc.syncPrivyWallet("ou", { privyWalletId: "pimp", address: A(9), source: "privy" })).source).toBe("imported");
  });

  it("reconciles unverified rows from Privy's record (imported_at) and skips address-only ids", async () => {
    await db.insert(schema.wallets).values({
      id: "w-addr",
      userId: "ou",
      privyWalletId: A(5),
      address: A(5),
      label: "x",
      source: "privy",
      isMain: false,
      createdAt: "2026-10-22T06:00:00.000Z",
    });
    const seen: string[] = [];
    const r = await svc.reconcileWalletSources({
      origin: async (_u, id) => {
        seen.push(String(id));
        return /^0x/.test(String(id)) ? null : { id: String(id), source: id === "pw-b" ? "imported" : "created", createdAt: null };
      },
    });
    expect(r.fixed).toBe(3);
    const by = Object.fromEntries((await svc.listWallets("ou")).map((w) => [w.id, w.source]));
    expect(by).toMatchObject({ "w-a": "created", "w-b": "imported", "w-c": "created", "w-addr": "privy" });
  });

  it("fresh import race (2026-10-22 wallet-6): address-only background sync, then the import form — ends Imported", async () => {
    // 1) The Wallets page's background sync sees the new Privy wallet first. Privy's connected-wallet object has no
    //    wallet id, so it sends the address; before the fix the row was stored as unverified "privy" → shown "Created".
    const bg = await svc.syncPrivyWallet("ou", { privyWalletId: A(20), address: A(20), source: "privy", imported: true });
    expect(bg.source).toBe("imported"); // the browser's `imported` flag is honoured
    // 2) Without the flag (older client), the import form's own save still upgrades it, and keeps the auto label
    //    instead of blanking it with an empty Label field.
    const bg2 = await svc.syncPrivyWallet("ou", { privyWalletId: A(21), address: A(21), source: "privy" });
    expect(bg2.source).toBe("privy");
    const imp = await svc.syncPrivyWallet("ou", { privyWalletId: "", address: A(21), label: "", source: "imported", restore: true });
    expect(imp.source).toBe("imported");
    expect(imp.label).toBe(bg2.label);
    // 3) Never downgraded by a later sync.
    expect((await svc.syncPrivyWallet("ou", { privyWalletId: A(21), address: A(21), source: "privy", imported: false })).source).toBe(
      "imported",
    );
  });

  it("healing re-checks recent 'created' rows and fixes address-only ids from Privy's user record", async () => {
    const t = new Date().toISOString();
    await db.insert(schema.wallets).values({
      id: "w-late",
      userId: "ou",
      privyWalletId: A(30),
      address: A(30),
      label: "late",
      source: "created",
      isMain: false,
      createdAt: t,
    });
    await svc.reconcileWalletSources({
      limit: 100,
      origin: async (_u, id, address) =>
        address.toLowerCase() === A(30) ? { id: "privy-late", source: "imported", createdAt: null } : null,
    });
    const w = (await svc.listWallets("ou")).find((x) => x.id === "w-late")!;
    expect(w).toMatchObject({ source: "imported", privyWalletId: "privy-late" });
  });
});
