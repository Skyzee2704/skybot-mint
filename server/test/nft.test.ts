// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";
import { Transaction, Wallet, getAddress } from "ethers";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "c".repeat(48);
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const now = () => new Date().toISOString();
const NFT = "0x1111111111111111111111111111111111111111";
const DEST = "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0";

describe("NFT indexer normalization", () => {
  it("normalizes Alchemy v3 entries (ERC-721, ERC-1155 balance, spam, https-only images)", async () => {
    const { fromAlchemy } = await import("../src/core/nft/indexer.js");
    const a = fromAlchemy({
      contract: { address: NFT, name: "C", tokenType: "ERC721", openSeaMetadata: { collectionName: "Cool", collectionSlug: "cool" } },
      tokenId: "42",
      tokenType: "ERC721",
      name: "Cool #42",
      image: { thumbnailUrl: "https://img/x.png" },
    })!;
    expect(a).toMatchObject({
      contract: getAddress(NFT),
      tokenId: "42",
      standard: "erc721",
      quantity: "1",
      collection: "Cool",
      spam: false,
    });
    const b = fromAlchemy({
      contract: { address: NFT, tokenType: "ERC1155", isSpam: true },
      tokenId: "7",
      tokenType: "ERC1155",
      balance: "5",
      image: { originalUrl: "javascript:alert(1)" },
    })!;
    expect(b).toMatchObject({ standard: "erc1155", quantity: "5", spam: true, image: null });
    expect(fromAlchemy({ contract: { address: NFT }, tokenId: "1", tokenType: "NO_SUPPORTED_NFT_STANDARD" })).toBeNull();
  });
  it("normalizes OpenSea entries (ERC-1155 quantity unknown)", async () => {
    const { fromOpenSea } = await import("../src/core/nft/indexer.js");
    expect(fromOpenSea({ identifier: "9", contract: NFT, token_standard: "erc1155", collection: "x", name: "n" })).toMatchObject({
      standard: "erc1155",
      quantity: null,
      collectionSlug: "x",
    });
  });
  it("derives the Alchemy key from an Alchemy RPC URL", async () => {
    const { alchemyKey } = await import("../src/core/nft/indexer.js");
    expect(alchemyKey({ RPC_BASE: "https://base-mainnet.g.alchemy.com/v2/abcDEF123456" } as any)).toBe("abcDEF123456");
    expect(alchemyKey({ RPC_BASE: "https://mainnet.base.org" } as any)).toBeNull();
  });
  it("paginates Alchemy and uses OpenSea for Ink", async () => {
    const { scanAlchemy, scanHoldings } = await import("../src/core/nft/indexer.js");
    const { requireChain } = await import("../src/config/chains.js");
    const urls: string[] = [];
    const page = (n: number, pageKey?: string) => ({
      ownedNfts: [{ contract: { address: NFT, tokenType: "ERC721" }, tokenId: String(n), tokenType: "ERC721" }],
      pageKey,
    });
    const f: any = async (u: string) => {
      urls.push(u);
      const body = u.includes("pageKey=p2")
        ? page(2)
        : u.includes("opensea")
          ? { nfts: [{ identifier: "3", contract: NFT, token_standard: "erc721" }] }
          : page(1, "p2");
      return { ok: true, status: 200, json: async () => body };
    };
    const r = await scanAlchemy(requireChain("base"), DEST, f, "KEY12345678");
    expect(r.items.map((i) => i.tokenId)).toEqual(["1", "2"]);
    expect(urls).toHaveLength(2);
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.RPC_INK = "https://ink-mainnet.g.alchemy.com/v2/KEY12345678";
    const ink = await scanHoldings(requireChain("ink"), DEST, f);
    expect(ink.source).toBe("opensea");
    expect(urls.at(-1)).toContain("api.opensea.io/api/v2/chain/ink/account/");
    delete process.env.RPC_INK;
  });
});

describe("NFT transfer building + verification", () => {
  it("encodes / decodes safeTransferFrom for both standards and reads ownership", async () => {
    const t = await import("../src/core/nft/transfer.js");
    const d721 = t.encodeTransfer("erc721", DEST, NFT, 5n, 1n);
    expect(t.decodeTransfer(d721)).toMatchObject({ standard: "erc721", tokenId: 5n, quantity: 1n, to: getAddress(NFT) });
    const d1155 = t.encodeTransfer("erc1155", DEST, NFT, 9n, 3n);
    expect(t.decodeTransfer(d1155)).toMatchObject({ standard: "erc1155", tokenId: 9n, quantity: 3n });
    expect(() => t.decodeTransfer("0xa9059cbb" + "00".repeat(64))).toThrow(/Not an NFT transfer/);
    const owner = "0x" + "0".repeat(24) + DEST.slice(2).toLowerCase();
    expect(t.heldFrom("erc721", DEST, true, owner)).toBe(1n);
    expect(t.heldFrom("erc721", NFT, true, owner)).toBe(0n);
    expect(t.heldFrom("erc721", DEST, false, "0x")).toBe(0n);
    expect(t.heldFrom("erc1155", DEST, true, "0x" + "0".repeat(63) + "4")).toBe(4n);
  });
  it("gas plan skips transfers the wallet can't pay for", async () => {
    const { planWalletGas } = await import("../src/core/nft/transfer.js");
    const p = planWalletGas(215n, 1n, [
      { key: "a", gasLimit: 100n, l1Fee: 0n },
      { key: "b", gasLimit: 100n, l1Fee: 10n },
      { key: "c", gasLimit: 100n, l1Fee: 0n },
    ]);
    expect(p.items.map((i) => i.ok)).toEqual([true, true, false]);
    expect(p.items[2].skip).toMatch(/gas/);
    expect(p.totalFee).toBe(210n);
    expect(p.needed).toBe(310n);
    expect(planWalletGas(0n, 1n, [{ key: "a", gasLimit: 1n, l1Fee: 0n }]).items[0].ok).toBe(false);
  });
  it("only broadcasts the exact quoted transfer", async () => {
    const t = await import("../src/core/nft/transfer.js");
    const w = Wallet.createRandom();
    const secret = Buffer.alloc(32, 7);
    const tx = {
      type: 0 as const,
      chainId: 8453,
      to: getAddress(NFT),
      value: "0x0" as const,
      nonce: 3,
      gasLimit: "0x186a0",
      gasPrice: "0x3b9aca00",
      data: t.encodeTransfer("erc721", w.address, DEST, 1n, 1n),
    };
    const exp = Date.now() + 60_000;
    const quoteToken = t.signNftQuote(secret, "u", "w1", w.address, tx, exp);
    const signedTx = await w.signTransaction({ ...tx, value: 0n, gasLimit: BigInt(tx.gasLimit), gasPrice: BigInt(tx.gasPrice) });
    const ok = t.verifySignedNftTx({ secret, userId: "u", walletId: "w1", from: w.address, tx, quoteToken, signed: signedTx });
    expect(ok.hash).toBe(Transaction.from(signedTx).hash);
    expect(ok.transfer.to).toBe(DEST);
    // 65-byte signature form (some Privy versions)
    const sigOnly = Transaction.from(signedTx).signature!.serialized;
    expect(t.verifySignedNftTx({ secret, userId: "u", walletId: "w1", from: w.address, tx, quoteToken, signed: sigOnly }).hash).toBe(
      ok.hash,
    );
    // tampered calldata (different destination) -> quote mismatch
    const evil = { ...tx, data: t.encodeTransfer("erc721", w.address, NFT, 1n, 1n) };
    expect(() =>
      t.verifySignedNftTx({ secret, userId: "u", walletId: "w1", from: w.address, tx: evil, quoteToken, signed: signedTx }),
    ).toThrow(/does not match/);
    // signed something else than quoted
    const other = await w.signTransaction({ ...tx, value: 1n, gasLimit: BigInt(tx.gasLimit), gasPrice: BigInt(tx.gasPrice) });
    expect(() => t.verifySignedNftTx({ secret, userId: "u", walletId: "w1", from: w.address, tx, quoteToken, signed: other })).toThrow(
      /differs/,
    );
    // other user / wallet / expired
    expect(() => t.verifySignedNftTx({ secret, userId: "x", walletId: "w1", from: w.address, tx, quoteToken, signed: signedTx })).toThrow();
    expect(() =>
      t.verifySignedNftTx({ secret, userId: "u", walletId: "w1", from: w.address, tx, quoteToken, signed: signedTx, now: exp + 1 }),
    ).toThrow(/expired/);
  });
});

describe("multicall + balance cache", () => {
  it("round-trips aggregate3 encoding", async () => {
    const { encodeAggregate3, multicallIface } = await import("../src/core/rpc/multicall.js");
    const data = encodeAggregate3([{ target: NFT, data: "0x1234" }]);
    expect(data.startsWith(multicallIface.getFunction("aggregate3")!.selector)).toBe(true);
  });
  it("loads all misses in one batch and dedupes concurrent reads", async () => {
    const { cachedBalances, clearBalanceCache } = await import("../src/util/balanceCache.js");
    clearBalanceCache();
    let calls = 0;
    const load = async (m: string[]) => {
      calls++;
      return new Map(m.map((a, i) => [a, BigInt(i + 1)]));
    };
    const [a, b] = await Promise.all([cachedBalances("base", [NFT, DEST], load), cachedBalances("base", [NFT, DEST], load)]);
    expect(calls).toBe(1);
    expect(a.get(NFT.toLowerCase())).toBe(1n);
    expect(b.get(DEST.toLowerCase())).toBe(2n);
    await cachedBalances("base", [NFT], load, { fresh: true });
    expect(calls).toBe(2);
  });
});

describe("NFT holdings cache + API", () => {
  let app: any;
  let signSession: (id: string) => { token: string };
  let holdings: typeof import("../src/core/nft/holdings.js");
  const A1 = "0x00000000000000000000000000000000000000a1";
  beforeAll(async () => {
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    const db = client.getDb();
    const schema = await import("../src/db/schema.js");
    for (const id of ["nu", "nb"])
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
    await db.insert(schema.wallets).values([
      { id: "nw1", userId: "nu", privyWalletId: "p1", address: A1, label: "one", source: "privy", isMain: true, createdAt: now() },
      { id: "nw2", userId: "nu", privyWalletId: "p2", address: DEST, label: "two", source: "privy", isMain: false, createdAt: now() },
      { id: "nbw", userId: "nb", privyWalletId: "p3", address: NFT, label: "bob", source: "privy", isMain: true, createdAt: now() },
    ]);
    holdings = await import("../src/core/nft/holdings.js");
    ({ signSession } = await import("../src/auth/session.js"));
    app = await (await import("../src/api/server.js")).buildServer();
  });
  const fakeScan = (calls: string[]) => async (c: any, owner: string) => {
    calls.push(`${c.key}:${owner}`);
    return {
      source: "alchemy" as const,
      truncated: false,
      items:
        c.key === "base" && owner === A1
          ? [
              {
                contract: getAddress(NFT),
                tokenId: "1",
                standard: "erc721" as const,
                quantity: "1",
                name: "A",
                collection: "Col",
                collectionSlug: "col",
                image: null,
                spam: false,
              },
              {
                contract: getAddress(NFT),
                tokenId: "2",
                standard: "erc1155" as const,
                quantity: "5",
                name: "B",
                collection: "Col",
                collectionSlug: "col",
                image: null,
                spam: false,
              },
            ]
          : [],
    };
  };

  it("scans missing pairs once, then serves from cache; manual refresh has a cooldown", async () => {
    const { CHAINS } = await import("../src/config/chains.js");
    const calls: string[] = [];
    const before = await holdings.holdingsView("nu");
    expect(before.missing).toBe(2 * CHAINS.length);
    const r = await holdings.refreshHoldings("nu", "missing", { scan: fakeScan(calls) as any });
    expect(r.scanned).toBe(2 * CHAINS.length);
    const again = await holdings.refreshHoldings("nu", "missing", { scan: fakeScan(calls) as any });
    expect(again.total).toBe(0); // nothing re-scanned
    const v = await holdings.holdingsView("nu");
    expect(v.missing).toBe(0);
    expect(v.items).toHaveLength(2);
    expect(v.items[0].walletId).toBe("nw1");
    const t0 = Date.now();
    await holdings.refreshHoldings("nu", "all", { scan: fakeScan(calls) as any, now: t0 });
    await expect(holdings.refreshHoldings("nu", "all", { scan: fakeScan(calls) as any, now: t0 + 5_000 })).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls.length).toBe(4 * CHAINS.length);
  });

  it("updates the cache optimistically after a send (no re-scan)", async () => {
    await holdings.applyTransferToCache("nu", {
      walletId: "nw1",
      chain: "base",
      contract: NFT,
      tokenId: "2",
      quantity: 2n,
      destination: DEST,
    });
    await holdings.applyTransferToCache("nu", {
      walletId: "nw1",
      chain: "base",
      contract: NFT,
      tokenId: "1",
      quantity: 1n,
      destination: DEST,
    });
    const v = await holdings.holdingsView("nu");
    const src = v.items.filter((i) => i.walletId === "nw1");
    const dst = v.items.filter((i) => i.walletId === "nw2");
    expect(src.map((i) => [i.tokenId, i.quantity])).toEqual([["2", "3"]]);
    expect(dst.map((i) => [i.tokenId, i.quantity]).sort()).toEqual([
      ["1", "1"],
      ["2", "2"],
    ]);
    expect((await holdings.cachedNftCount("nu", "nw2")).total).toBe(2);
  });

  const call = (method: string, url: string, user: string | null, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload,
      headers: user ? { cookie: `sb_session=${encodeURIComponent(signSession(user).token)}`, "x-skybot-csrf": "1" } : {},
    });

  it("API: auth required, cached reads are scoped per user, no cross-user sends", async () => {
    expect((await call("GET", "/api/nfts", null)).statusCode).toBe(401);
    const mine = (await call("GET", "/api/nfts", "nu")).json();
    expect(mine.items.length).toBeGreaterThan(0);
    const bob = (await call("GET", "/api/nfts", "nb")).json();
    expect(bob.items).toHaveLength(0);
    expect(bob.wallets.map((w: any) => w.id)).toEqual(["nbw"]);
    const q = await call("POST", "/api/nfts/send/quote", "nu", {
      to: DEST,
      items: [{ walletId: "nbw", chain: "base", contract: NFT, tokenId: "1", standard: "erc721" }],
    });
    expect(q.statusCode).toBe(404);
    const z = await call("POST", "/api/nfts/send/quote", "nu", {
      to: "0x0000000000000000000000000000000000000000",
      items: [{ walletId: "nw1", chain: "base", contract: NFT, tokenId: "1", standard: "erc721" }],
    });
    expect(z.statusCode).toBe(400);
    const s = await call("POST", "/api/nfts/send", "nu", {
      chain: "base",
      walletId: "nbw",
      tx: { type: 0, chainId: 8453, to: NFT, value: "0x0", nonce: 0, gasLimit: "0x1", gasPrice: "0x1", data: "0x" },
      quoteToken: "1.x",
      signed: "0x" + "00".repeat(65),
    });
    expect(s.statusCode).toBe(404);
    const forged = await call("POST", "/api/nfts/send", "nu", {
      chain: "base",
      walletId: "nw1",
      tx: { type: 0, chainId: 8453, to: NFT, value: "0x0", nonce: 0, gasLimit: "0x1", gasPrice: "0x1", data: "0x" },
      quoteToken: `${Date.now() + 60_000}.forged`,
      signed: "0x" + "00".repeat(65),
    });
    expect(forged.statusCode).toBe(400);
  });

  it("wallet removal is blocked while the cache shows NFTs", async () => {
    const { decideRemoval } = await import("../src/users/walletRemoval.js");
    const d = decideRemoval({
      balances: [{ chain: "base", chainName: "Base", symbol: "ETH", balanceWei: "0", balance: "0", error: null }],
      mintedNfts: 0,
      privy: { id: "abcdefghijklmnopqrstu", primaryEmbedded: false, imported: true },
      privyAvailable: true,
      heldNfts: { total: 2, byChain: [{ chain: "base", count: 2 }] },
    });
    expect(d.canDelete).toBe(false);
    expect(d.notes.join(" ")).toMatch(/NFTs page/);
  });
});
