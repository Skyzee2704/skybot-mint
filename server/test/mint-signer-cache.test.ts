// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "s".repeat(48);
process.env.PRIVY_APP_ID = "app";
process.env.PRIVY_APP_SECRET = "secret-for-tests";

const appKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APP_KEY = appKey.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const APP_PUB = appKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");

let quorumThrows = false;
const quorums: Record<string, any> = { mintquorum: { authorization_keys: [{ public_key: APP_PUB }] } };
const privyWallets: Record<string, any> = {};

vi.mock("../src/auth/privy.js", () => ({
  getPrivy: () => ({
    wallets: () => ({
      get: async (wid: string) => privyWallets[wid],
    }),
    users: () => ({ _get: async () => ({ linked_accounts: [] }) }),
    keyQuorums: () => ({
      get: async (q: string) => {
        if (quorumThrows) throw new Error("quorum unavailable");
        return quorums[q] ?? { authorization_keys: [] };
      },
    }),
  }),
}));

describe("mint signer negative + diag cache", () => {
  beforeAll(async () => {
    const { ensureDb } = await import("../src/db/client.js");
    await ensureDb();
  });
  beforeEach(() => {
    process.env.PRIVY_AUTH_PRIVATE_KEY = `wallet-auth:${APP_KEY}`;
    process.env.PRIVY_AUTH_KEY_QUORUM_ID = "mintquorum";
    quorumThrows = false;
  });

  it("reuses a fresh missing check (~60s) without re-hitting Privy", async () => {
    const { checkMintSigner, mintSignerStatus, NEGATIVE_CACHE_MS } = await import("../src/users/mintSigner.js");
    const { getDb } = await import("../src/db/client.js");
    const { users, wallets, mintSigners } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    const now = new Date().toISOString();
    await db
      .insert(users)
      .values({ id: "ucache", privyUserId: "did:cache", createdAt: now, lastSeenAt: now } as any)
      .onConflictDoNothing();
    await db
      .insert(wallets)
      .values({
        id: "wc1",
        userId: "ucache",
        address: "0x" + "c".repeat(40),
        privyWalletId: "pwcacheaaaaaaaaaaaaaaaaa",
        source: "imported",
        createdAt: now,
      } as any)
      .onConflictDoNothing();
    privyWallets.pwcacheaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [] };
    await checkMintSigner({
      id: "wc1",
      userId: "ucache",
      address: "0x" + "c".repeat(40),
      privyWalletId: "pwcacheaaaaaaaaaaaaaaaaa",
    });
    privyWallets.pwcacheaaaaaaaaaaaaaaaaa = {
      owner_id: "user-owner",
      additional_signers: [{ signer_id: "mintquorum" }],
    };
    expect((await mintSignerStatus({ id: "ucache", privyUserId: "did:cache" })).missingAddresses).toContain("0x" + "c".repeat(40));
    await db
      .update(mintSigners)
      .set({ checkedAt: new Date(Date.now() - NEGATIVE_CACHE_MS - 1_000).toISOString() })
      .where(eq(mintSigners.walletId, "wc1"));
    expect((await mintSignerStatus({ id: "ucache", privyUserId: "did:cache" })).attachedAddresses).toContain("0x" + "c".repeat(40));
  });

  it("mintSigningProblem finds missing wallets under the overall timeout", async () => {
    const { mintSigningProblem } = await import("../src/users/mintSigner.js");
    privyWallets.pwpaaaaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [] };
    privyWallets.pwpbaaaaaaaaaaaaaaaaaaaa = {
      owner_id: "user-owner",
      additional_signers: [{ signer_id: "mintquorum" }],
    };
    const p = await mintSigningProblem([
      { id: "wa", userId: "u", address: "0x" + "1".repeat(40), privyWalletId: "pwpaaaaaaaaaaaaaaaaaaaaa" },
      { id: "wb", userId: "u", address: "0x" + "2".repeat(40), privyWalletId: "pwpbaaaaaaaaaaaaaaaaaaaa" },
    ]);
    expect(p?.missing).toEqual(["0x" + "1".repeat(40)]);
  });

  it("diag does not stick a null keyInQuorum in the long-lived cache", async () => {
    const { mintSignerDiag } = await import("../src/users/mintSigner.js");
    process.env.PRIVY_AUTH_KEY_QUORUM_ID = "mintquorum-diag";
    quorums["mintquorum-diag"] = { authorization_keys: [{ public_key: APP_PUB }] };
    quorumThrows = true;
    const broken = await mintSignerDiag();
    expect(broken?.keyInQuorum).toBeNull();
    quorumThrows = false;
    const ok = await mintSignerDiag();
    expect(ok?.keyInQuorum).toBe(true);
  });
});
