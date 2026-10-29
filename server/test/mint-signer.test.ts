// SPDX-License-Identifier: AGPL-3.0-only
// Mint jobs failed before any tx was sent: production had no signing key and no wallet carried the mint signer.
// These cover the up-front refusal, the clear per-wallet reasons and the signing-key normalisation.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { AbiCoder, id } from "ethers";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "s".repeat(48);
process.env.PRIVY_APP_ID = "app";
process.env.PRIVY_APP_SECRET = "secret-for-tests";

const appKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APP_KEY = appKey.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const APP_PUB = appKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const quorums: Record<string, any> = { mintquorum: { authorization_keys: [{ public_key: APP_PUB }] } };
const privyWallets: Record<string, any> = {};
const failGet = new Set<string>();
vi.mock("../src/auth/privy.js", () => ({
  getPrivy: () => ({
    wallets: () => ({
      get: async (wid: string) => {
        if (failGet.has(wid)) throw new Error("503 upstream");
        return privyWallets[wid];
      },
    }),
    users: () => ({ _get: async () => ({ linked_accounts: [] }) }),
    keyQuorums: () => ({ get: async (q: string) => quorums[q] ?? { authorization_keys: [] } }),
  }),
}));

const W = (n: number, privyWalletId: string) => ({
  id: `w${n}`,
  userId: "u1",
  address: `0x${String(n).repeat(40)}`.slice(0, 42),
  privyWalletId,
});

describe("mint signer readiness", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/db/client.js");
    getDb();
  });
  beforeEach(() => {
    process.env.PRIVY_AUTH_PRIVATE_KEY = `wallet-auth:${APP_KEY}`;
    process.env.PRIVY_AUTH_KEY_QUORUM_ID = "mintquorum";
    failGet.clear();
  });

  it("no signing key: every job is refused up front with the reason (what happened on 2026-10-28)", async () => {
    delete process.env.PRIVY_AUTH_PRIVATE_KEY;
    const { mintSigningProblem, SIGNING_OFF_MESSAGE } = await import("../src/users/mintSigner.js");
    const p = await mintSigningProblem([W(1, "pw1aaaaaaaaaaaaaaaaaaaa")]);
    expect(p?.message).toBe(SIGNING_OFF_MESSAGE);
    expect(SIGNING_OFF_MESSAGE).toMatch(/nothing was signed or sent/);
  });

  it("wallet without the mint signer (only the sign-in signer): refused, naming the wallet and the fix", async () => {
    privyWallets.pw2aaaaaaaaaaaaaaaaaaaa = {
      owner_id: "user-owner",
      additional_signers: [{ signer_id: "siwequorum", override_policy_ids: ["p"] }],
    };
    const { mintSigningProblem } = await import("../src/users/mintSigner.js");
    const w = W(2, "pw2aaaaaaaaaaaaaaaaaaaa");
    const p = await mintSigningProblem([w]);
    expect(p?.missing).toEqual([w.address]);
    expect(p?.message).toMatch(/Open the SkyBOT app once/);
    expect(p?.message).toContain(w.address);
  });

  it("wallet with the mint signer (or owned by the app quorum) passes; Privy lookup errors never block", async () => {
    privyWallets.pw3aaaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [{ signer_id: "mintquorum" }] };
    privyWallets.pw4aaaaaaaaaaaaaaaaaaaa = { owner_id: "mintquorum", additional_signers: [] };
    failGet.add("pw5aaaaaaaaaaaaaaaaaaaa");
    const { mintSigningProblem } = await import("../src/users/mintSigner.js");
    expect(
      await mintSigningProblem([W(3, "pw3aaaaaaaaaaaaaaaaaaaa"), W(4, "pw4aaaaaaaaaaaaaaaaaaaa"), W(5, "pw5aaaaaaaaaaaaaaaaaaaa")]),
    ).toBeNull();
  });

  it("signing key unreadable / not in the quorum: refused before any wallet is checked", async () => {
    const { mintSigningProblem, mintSignerDiag, KEY_UNREADABLE_MESSAGE, KEY_NOT_IN_QUORUM_MESSAGE } =
      await import("../src/users/mintSigner.js");
    const pub = appKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env.PRIVY_AUTH_PRIVATE_KEY = pub; // public key pasted by mistake
    expect((await mintSigningProblem([W(8, "pw8aaaaaaaaaaaaaaaaaaaa")]))?.message).toBe(KEY_UNREADABLE_MESSAGE);
    expect((await mintSignerDiag())?.keyShape).toBe("public_key");
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    process.env.PRIVY_AUTH_PRIVATE_KEY = other;
    expect((await mintSigningProblem([W(8, "pw8aaaaaaaaaaaaaaaaaaaa")]))?.message).toBe(KEY_NOT_IN_QUORUM_MESSAGE);
    process.env.PRIVY_AUTH_PRIVATE_KEY = `wallet-auth:${APP_KEY}`;
    expect(await mintSignerDiag()).toEqual({ keyReadable: true, keyShape: "ok", quorumConfigured: true, keyInQuorum: true });
  });

  it("quorum change: an earlier mint quorum doesn't count; policy is optional; a cached attach is tied to the quorum", async () => {
    const { mintSignerOnWallet, mintSigningProblem } = await import("../src/users/mintSigner.js");
    const old = { owner_id: "user-owner", additional_signers: [{ signer_id: "siwequorum" }, { signer_id: "oldmintquorum" }] };
    expect(mintSignerOnWallet(old)).toBe("missing");
    expect(mintSignerOnWallet({ ...old, additional_signers: [...old.additional_signers, { signer_id: "mintquorum" }] })).toBe("attached");
    // No PRIVY_MINT_POLICY_ID: a signer without override policy is fully attached.
    delete process.env.PRIVY_MINT_POLICY_ID;
    expect(mintSignerOnWallet({ additional_signers: [{ signer_id: "mintquorum" }] })).toBe("attached");
    process.env.PRIVY_MINT_POLICY_ID = "pol1";
    expect(mintSignerOnWallet({ additional_signers: [{ signer_id: "mintquorum" }] })).toBe("policy_upgrade");
    expect(mintSignerOnWallet({ additional_signers: [{ signer_id: "mintquorum", override_policy_ids: ["pol1"] }] })).toBe("attached");
    delete process.env.PRIVY_MINT_POLICY_ID;
    // Wallet attached for the old quorum, then the quorum changes: refused until the new one is added.
    privyWallets.pw9aaaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [{ signer_id: "mintquorum" }] };
    expect(await mintSigningProblem([W(9, "pw9aaaaaaaaaaaaaaaaaaaa")])).toBeNull();
    privyWallets.pw9aaaaaaaaaaaaaaaaaaaa = old;
    expect((await mintSigningProblem([W(9, "pw9aaaaaaaaaaaaaaaaaaaa")]))?.missing).toHaveLength(1);
  });

  it("status report: cached attach only counts for the same quorum", async () => {
    const { mintSignerStatus } = await import("../src/users/mintSigner.js");
    const { getDb } = await import("../src/db/client.js");
    const { users, wallets, mintSigners } = await import("../src/db/schema.js");
    const db = getDb();
    await db
      .insert(users)
      .values({ id: "u9", privyUserId: "did:privy:x", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } as any)
      .onConflictDoNothing();
    await db
      .insert(wallets)
      .values({
        id: "w10",
        userId: "u9",
        address: "0x" + "a".repeat(40),
        privyWalletId: "pw10aaaaaaaaaaaaaaaaaaa",
        source: "imported",
        createdAt: new Date().toISOString(),
      } as any)
      .onConflictDoNothing();
    await db
      .insert(mintSigners)
      .values({ walletId: "w10", attachedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), note: "q:oldmintquorum|p:" })
      .onConflictDoNothing();
    privyWallets.pw10aaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [{ signer_id: "oldmintquorum" }] };
    const r = await mintSignerStatus({ id: "u9", privyUserId: "did:privy:x" });
    expect(r.missingAddresses).toEqual(["0x" + "a".repeat(40)]);
    privyWallets.pw10aaaaaaaaaaaaaaaaaaa.additional_signers.push({ signer_id: "mintquorum" });
    expect((await mintSignerStatus({ id: "u9", privyUserId: "did:privy:x" })).attachedAddresses).toHaveLength(1);
  });

  it("several wallets missing: one message listing them", async () => {
    privyWallets.pw6aaaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [] };
    privyWallets.pw7aaaaaaaaaaaaaaaaaaaa = { owner_id: "user-owner", additional_signers: [] };
    const { mintSigningProblem } = await import("../src/users/mintSigner.js");
    const p = await mintSigningProblem([W(6, "pw6aaaaaaaaaaaaaaaaaaaa"), W(7, "pw7aaaaaaaaaaaaaaaaaaaa")]);
    expect(p?.missing).toHaveLength(2);
    expect(p?.message).toMatch(/for 2 wallets/);
  });

  it("Privy refusals while signing map to the clear reason; other errors don't", async () => {
    const { privySigningRefusal } = await import("../src/users/mintSigner.js");
    const a = "0x90d0000000000000000000000000000000000000";
    expect(privySigningRefusal(Object.assign(new Error("No valid authorization signature"), { status: 401 }), a)).toMatch(
      /Open the SkyBOT app once/,
    );
    expect(privySigningRefusal({ status: 403, message: "Forbidden" }, a)).toMatch(/isn't enabled yet/);
    expect(privySigningRefusal(new Error("Transaction denied by policy rule"), a)).toMatch(/policy/);
    expect(privySigningRefusal(new Error("invalid private key: not valid base64"), a)).toMatch(/misconfigured/);
    expect(privySigningRefusal(new Error("socket hang up"), a)).toBeNull();
  });
});

describe("Privy authorization key normalisation", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");

  it("accepts bare, prefixed, PKCS#8 PEM, SEC1 PEM, base64 PEM and escaped newlines — all to the same bare key", async () => {
    const { normalizeAuthKey, authPublicKey, samePublicKey } = await import("../src/auth/authKey.js");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }).toString();
    for (const v of [pkcs8, `wallet-auth:${pkcs8}`, pem, sec1, Buffer.from(pem).toString("base64"), pem.replace(/\n/g, "\\n")])
      expect(normalizeAuthKey(v)).toBe(pkcs8);
    expect(normalizeAuthKey("not a key")).toBeNull();
    expect(authPublicKey(pkcs8)).toBe(spki);
    expect(samePublicKey(publicKey.export({ type: "spki", format: "pem" }).toString(), spki)).toBe(true);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(samePublicKey(other, spki)).toBe(false);
  });
});

describe("job failure messages use the revert decoder", () => {
  const chain = { key: "base", chainId: 8453, nativeSymbol: "ETH" } as any;
  const ctx = { chain, contract: "0x0000000000000000000000000000000000000001" };
  const revertErr = (reason: string) => ({
    code: "CALL_EXCEPTION",
    data: id("Error(string)").slice(0, 10) + AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2),
    message: "execution reverted",
  });

  it("reverted on-chain: replays at the block and shows the contract's reason", async () => {
    const { revertedOnChainMessage } = await import("../src/core/mint/jobErrors.js");
    const tags: number[] = [];
    const m = await revertedOnChainMessage(
      async (t) => {
        tags.push(t);
        throw revertErr("Sale not active");
      },
      100,
      50_000n,
      200_000n,
      ctx,
    );
    expect(tags).toEqual([99]);
    expect(m).toMatch(/^Reverted on-chain: .*Sale not active/i);
  });

  it("out of gas and passing replays are named", async () => {
    const { revertedOnChainMessage } = await import("../src/core/mint/jobErrors.js");
    expect(await revertedOnChainMessage(async () => "0x", 5, 200_000n, 200_000n, ctx)).toMatch(/ran out of gas/);
    expect(await revertedOnChainMessage(async () => "0x", 5, 1n, 200_000n, ctx)).toMatch(/state changed/);
  });

  it("broadcast rejections: funds / nonce / fee / generic", async () => {
    const { broadcastRejectedMessage } = await import("../src/core/mint/jobErrors.js");
    expect(broadcastRejectedMessage(["insufficient funds for gas * price + value"], "ETH")).toMatch(/^Not enough ETH/);
    expect(broadcastRejectedMessage(["nonce too low"], "ETH")).toMatch(/same nonce/);
    expect(broadcastRejectedMessage(["max fee per gas less than block base fee"], "ETH")).toMatch(/base fee/);
    expect(broadcastRejectedMessage(["boom", "boom"], "ETH")).toBe("Rejected by all RPCs: boom");
  });

  it("signing / build failures: decoded, never the raw provider dump", async () => {
    const { signFailureMessage, buildFailureMessage, jobFailureMessage } = await import("../src/core/mint/jobErrors.js");
    const { MintBuildError } = await import("../src/core/mint/build.js");
    expect(await signFailureMessage({ status: 401, message: "unauthorized" }, "0xabc", ctx)).toMatch(/isn't enabled yet for wallet 0xabc/);
    expect(await buildFailureMessage(revertErr("Not whitelisted"), ctx)).toMatch(/^Couldn't prepare the mint: .*Not whitelisted/i);
    const be = new MintBuildError("Stage not live yet", "NOT_ACTIVE");
    expect(await buildFailureMessage(be, ctx)).toBe(be.message);
    expect(await jobFailureMessage(revertErr("Paused"))).toMatch(/Paused/i);
  });
});
