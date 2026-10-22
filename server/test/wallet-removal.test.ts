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
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

beforeAll(async () => {
  const client = await import("../src/db/client.js");
  await client.ensureDb();
  db = client.getDb();
  schema = await import("../src/db/schema.js");
  svc = await import("../src/users/service.js");
  await db.insert(schema.users).values({
    id: "u1",
    privyUserId: "did:privy:u1",
    email: null,
    name: null,
    role: "user",
    disabled: false,
    telegramUserId: null,
    telegramUsername: null,
    createdAt: now(),
    lastSeenAt: now(),
  });
});

describe("wallet removal", () => {
  it("hidden wallets are not resurrected by Privy sync and are excluded from every list", async () => {
    const a = await svc.syncPrivyWallet("u1", { privyWalletId: "pa", address: A });
    const b = await svc.syncPrivyWallet("u1", { privyWalletId: "pb", address: B });
    expect(a.isMain).toBe(true);
    await svc.hideWallet("u1", a.id!);
    // Background sync (Wallets page) reports the same Privy wallet again.
    const again = await svc.syncPrivyWallet("u1", { privyWalletId: "pa", address: A });
    expect((again as any).skipped).toBe("removed");
    const active = await svc.listWallets("u1");
    expect(active.map((w) => w.address)).toEqual([B]);
    expect(active[0]!.isMain).toBe(true); // main moved to the remaining wallet
    expect((await svc.walletsOverview("u1")).removedWallets.map((w) => w.address)).toEqual([A]);
    await expect(svc.getWallet("u1", a.id!)).rejects.toThrow(/removed/);
    // Explicit restore brings it back.
    await svc.restoreWallet("u1", a.id!);
    expect((await svc.listWallets("u1")).length).toBe(2);
    await svc.hideWallet("u1", b.id!);
  });

  it("deleted wallets leave a tombstone; sync never re-adds them unless the user explicitly re-imports", async () => {
    const c = await svc.syncPrivyWallet("u1", { privyWalletId: "pc", address: C });
    await svc.hardDeleteWallet("u1", c.id!);
    const again = await svc.syncPrivyWallet("u1", { privyWalletId: "pc", address: C });
    expect((again as any).skipped).toBe("deleted");
    expect((await svc.listWallets("u1")).some((w) => w.address === C)).toBe(false);
    const re = await svc.syncPrivyWallet("u1", { privyWalletId: "pc2", address: C, source: "imported", restore: true });
    expect((re as any).skipped).toBeUndefined();
    expect((await svc.listWallets("u1")).some((w) => w.address === C)).toBe(true);
  });

  it("removing a wallet cancels or trims its scheduled jobs", async () => {
    const [w1, w2] = await svc.listWallets("u1");
    const mk = (id: string, ws: string[]) =>
      db.insert(schema.jobs).values({
        id,
        userId: "u1",
        createdAt: now(),
        status: "scheduled",
        runAt: now(),
        chain: "base",
        target: A,
        strategy: "seadrop_public",
        requestJson: JSON.stringify({ wallets: ws.map((walletId) => ({ walletId, quantity: 1 })) }),
        resultsJson: "[]",
        logJson: "[]",
      });
    await mk("j-solo", [w1!.id]);
    await mk("j-both", [w1!.id, w2!.id]);
    const r = await svc.hideWallet("u1", w1!.id);
    expect(r).toEqual({ cancelledJobs: 1, trimmedJobs: 1 });
    const { getJob } = await import("../src/core/jobs/repo.js");
    const solo = await getJob("u1", "j-solo");
    expect(solo!.status).toBe("cancelled");
    expect(solo!.error).toMatch(/was removed/);
    const both = await getJob("u1", "j-both");
    expect(both!.status).toBe("scheduled");
    expect(both!.request.wallets.map((x: any) => x.walletId)).toEqual([w2!.id]);
  });
});

describe("delete decision", () => {
  const bal = (chain: string, wei: string | null) => ({
    chain,
    chainName: chain,
    symbol: "ETH",
    balanceWei: wei,
    balance: wei,
    error: wei === null ? "rpc" : null,
  });
  const privy = { id: "abcdefghijklmnopqrstuvwx", primaryEmbedded: false, imported: false };
  it("blocks deletion when any chain has funds or a balance couldn't be read", async () => {
    const { decideRemoval } = await import("../src/users/walletRemoval.js");
    expect(
      decideRemoval({ balances: [bal("base", "0"), bal("ethereum", "5")], mintedNfts: 0, privy, privyAvailable: true }).canDelete,
    ).toBe(false);
    expect(
      decideRemoval({ balances: [bal("base", "0"), bal("ethereum", null)], mintedNfts: 0, privy, privyAvailable: true }).canDelete,
    ).toBe(false);
    expect(decideRemoval({ balances: [bal("base", "0")], mintedNfts: 2, privy, privyAvailable: true }).canDelete).toBe(false);
    const ok = decideRemoval({ balances: [bal("base", "0"), bal("ethereum", "0")], mintedNfts: 0, privy, privyAvailable: true });
    expect(ok.canDelete).toBe(true);
    expect(ok.deleteMode).toBe("archive_and_delete");
  });
  it("never archives the primary embedded wallet", async () => {
    const { decideRemoval } = await import("../src/users/walletRemoval.js");
    const d = decideRemoval({
      balances: [bal("base", "0")],
      mintedNfts: 0,
      privy: { ...privy, primaryEmbedded: true },
      privyAvailable: true,
    });
    expect(d.deleteMode).toBe("hide_only");
  });
});
