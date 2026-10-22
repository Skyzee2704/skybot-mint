// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "e".repeat(48);
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const bal = (chain: string, wei: string | null) => ({ chain, chainName: chain, symbol: "ETH", balanceWei: wei, balance: wei, error: wei === null ? "rpc" : null });
const privy = { id: "abcdefghijklmnopqrstuvwx", primaryEmbedded: false, imported: false };

describe("removing a wallet that still holds funds", () => {
  it("is allowed, but only with the acknowledgement and the typed wallet name", async () => {
    const { decideRemoval, confirmationProblem } = await import("../src/users/walletRemoval.js");
    const d = decideRemoval({ balances: [bal("base", "5"), bal("ink", null)], mintedNfts: 0, privy, privyAvailable: true });
    expect(d).toMatchObject({ canDelete: false, requiresConfirmation: true, deleteMode: "archive_and_delete", walletKind: "created" });
    const chk = { ...d, label: "wallet-3" };
    expect(confirmationProblem(chk, {})).toMatch(/Tick/);
    expect(confirmationProblem(chk, { acknowledge: true, confirmLabel: "wallet 3" })).toMatch(/Type the wallet name/);
    expect(confirmationProblem(chk, { acknowledge: true, confirmLabel: "  Wallet-3 " })).toBeNull();
    // Empty wallets need no typed confirmation.
    const empty = decideRemoval({ balances: [bal("base", "0")], mintedNfts: 0, privy, privyAvailable: true });
    expect(confirmationProblem({ ...empty, label: "x" }, {})).toBeNull();
    // Cached NFTs also require confirmation.
    const withNfts = decideRemoval({ balances: [bal("base", "0")], mintedNfts: 0, privy, privyAvailable: true, heldNfts: { total: 2, byChain: [{ chain: "base", count: 2 }] } });
    expect(withNfts.requiresConfirmation).toBe(true);
  });

  it("warns per wallet type: created wallets may be unrecoverable, imported ones stay usable with the user's key", async () => {
    const { decideRemoval } = await import("../src/users/walletRemoval.js");
    const created = decideRemoval({ balances: [bal("base", "5")], mintedNfts: 0, privy, privyAvailable: true });
    expect(created.warnings.join(" ")).toMatch(/unrecoverable/);
    expect(created.warnings.join(" ")).toMatch(/archives the wallet in Privy/);
    const imported = decideRemoval({ balances: [bal("base", "5")], mintedNfts: 0, privy: { ...privy, imported: true }, privyAvailable: true });
    expect(imported.walletKind).toBe("imported");
    expect(imported.warnings.join(" ")).toMatch(/own copy of its private key/);
    const primary = decideRemoval({ balances: [bal("base", "5")], mintedNfts: 0, privy: { ...privy, primaryEmbedded: true }, privyAvailable: true });
    expect(primary).toMatchObject({ deleteMode: "hide_only", walletKind: "primary", requiresConfirmation: false });
  });
});

describe("removing the Main wallet", () => {
  let svc: typeof import("../src/users/service.js");
  let rm: typeof import("../src/users/walletRemoval.js");
  const user = { id: "mu2", privyUserId: "tg:1" } as any;
  beforeAll(async () => {
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    const db = client.getDb();
    const schema = await import("../src/db/schema.js");
    const t = new Date().toISOString();
    await db.insert(schema.users).values({ id: "mu2", privyUserId: "tg:1", role: "user", disabled: false, createdAt: t, lastSeenAt: t });
    const rows = [
      ["m", "2026-10-22T05:00:00.000Z", true],
      ["old", "2026-10-21T01:00:00.000Z", false],
      ["new", "2026-10-22T06:00:00.000Z", false],
    ] as const;
    let n = 1;
    for (const [id, createdAt, isMain] of rows)
      await db.insert(schema.wallets).values({ id, userId: "mu2", address: `0x${(n++).toString(16).padStart(40, "0")}`, label: id, privyWalletId: null, source: "imported", isMain, createdAt });
    svc = await import("../src/users/service.js");
    rm = await import("../src/users/walletRemoval.js");
  });

  it("hands Main to the wallet the member picked", async () => {
    const r = await rm.removeWalletForUser(user, "m", "hide", { newMainId: "new" });
    expect(r.newMain).toBe("new");
    expect(r.message).toMatch(/new is now your Main wallet/);
    expect((await svc.listWallets("mu2")).map((w) => [w.id, w.isMain])).toEqual([
      ["new", true],
      ["old", false],
    ]);
  });

  it("defaults to the oldest remaining wallet, and rejects a pick that isn't the member's", async () => {
    await expect(rm.removeWalletForUser(user, "new", "hide", { newMainId: "someone-else" })).rejects.toThrow(/new Main/);
    const r = await rm.removeWalletForUser(user, "new", "hide");
    expect(r.newMain).toBe("old");
    expect((await svc.listWallets("mu2"))[0]).toMatchObject({ id: "old", isMain: true });
  });
});
