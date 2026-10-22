// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "c".repeat(48);
process.env.OPENSEA_API_KEY = "test-opensea-key";
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const C = getAddress("0x138f21e24dcf39299aaed49b71d483bfc6d2e107");
const OLD = "ipfs://bafkreiexyfypep4bmtkxnh7be5qtnipery5bakl6ayxsdyvmxhraelxamy";
const NEW = "ipfs://bafybeibcz5hwaozcysu7hcmx4jqcfpzwfc7mutcq4bx7rz2t6eqoulkhym/1347";
const item = (o: any = {}) => ({
  contract: C,
  tokenId: "1347",
  standard: "erc721" as const,
  quantity: "1",
  name: "Pre reveal",
  collection: "Drip Dragons",
  collectionSlug: "drip-dragons",
  image: "https://res.cloudinary.com/alchemyapi/image/upload/thumbnailv2/robinhood-mainnet/pre.png",
  spam: false,
  tokenUri: OLD,
  ...o,
});
const res = (j: any, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => j });

describe("token URI helpers", () => {
  it("canonicalizes ipfs gateways, arweave and long data URIs", async () => {
    const { canonUri, sameUri } = await import("../src/core/nft/uri.js");
    expect(canonUri("https://ipfs2.seadn.io/ipfs/QmX/1")).toBe("ipfs://QmX/1");
    expect(canonUri("ipfs://ipfs/QmX/1")).toBe("ipfs://QmX/1");
    expect(canonUri("https://arweave.net/abc/2")).toBe("ar://abc/2");
    expect(canonUri("data:application/json;base64," + "A".repeat(400))).toMatch(/^sha256:/);
    expect(canonUri("")).toBeNull();
    expect(sameUri("ipfs://QmX/1", "https://gateway.pinata.cloud/ipfs/QmX/1", "1")).toBe(true);
    // ERC-1155 {id}: hex form (EIP-1155) and the decimal form some indexers store
    expect(sameUri("https://x.io/5", "https://x.io/{id}", "5")).toBe(true);
    expect(sameUri(`https://x.io/${"0".repeat(63)}5`, "https://x.io/{id}", "5")).toBe(true);
    expect(sameUri(OLD, NEW, "1347")).toBe(false);
  });
  it("flags unrevealed-looking items", async () => {
    const { looksUnrevealed } = await import("../src/core/nft/metadata.js");
    expect(looksUnrevealed(item())).toBe(true);
    expect(looksUnrevealed(item({ name: "Unrevealed Meowz" }))).toBe(true);
    expect(looksUnrevealed(item({ name: "Drip Dragon #1347" }))).toBe(false);
    const a = item({ name: "Box", tokenId: "1", image: "https://i/same.png" });
    const b = item({ name: "Box", tokenId: "2", image: "https://i/same.png" });
    expect(looksUnrevealed(a, [a, b])).toBe(true);
    expect(looksUnrevealed(item({ spam: true }))).toBe(false);
  });
});

describe("verifyMetadata", () => {
  const chain = async () => (await import("../src/config/chains.js")).requireChain("robinhood");

  it("repairs a token whose indexer URI no longer matches tokenURI() on-chain (OpenSea built from the same URI)", async () => {
    const { verifyMetadata } = await import("../src/core/nft/metadata.js");
    const urls: string[] = [];
    const f = async (u: string) => {
      urls.push(u);
      if (u.includes("api.opensea.io"))
        return res({
          nft: {
            name: "Drip Dragon #1347",
            display_image_url: "https://i2c.seadn.io/robinhood/x/revealed.png",
            metadata_url: "https://ipfs2.seadn.io/ipfs/bafybeibcz5hwaozcysu7hcmx4jqcfpzwfc7mutcq4bx7rz2t6eqoulkhym/1347",
          },
        });
      return res({});
    };
    const fresh = item({ tokenId: "9", name: "Drip Dragon #9", tokenUri: "ipfs://cid/9" });
    const r = await verifyMetadata(await chain(), [item(), fresh], [], {
      fetchImpl: f as any,
      readUris: async (_c, its) => its.map((i) => (i.tokenId === "1347" ? NEW : "ipfs://cid/9")),
    });
    expect(r.fixed).toBe(1);
    expect(r.items[0]).toMatchObject({ name: "Drip Dragon #1347", image: "https://i2c.seadn.io/robinhood/x/revealed.png" });
    expect(r.items[0].meta).toMatchObject({ fixed: true, via: "opensea", uri: NEW });
    expect(r.items[1]).toMatchObject({ name: "Drip Dragon #9", meta: { uri: "ipfs://cid/9" } });
    expect(urls.filter((u) => u.includes("api.opensea.io"))).toHaveLength(1); // only the stale token
  });

  it("falls back to the on-chain URI's JSON when OpenSea is stale, and reuses the fix on the next scan", async () => {
    const { verifyMetadata } = await import("../src/core/nft/metadata.js");
    let calls = 0;
    const f = async (u: string) => {
      calls++;
      if (u.includes("api.opensea.io")) return res({ nft: { name: "Pre reveal", metadata_url: OLD } }); // not rebuilt yet
      if (u.startsWith("https://gateway.pinata.cloud/ipfs/bafybei"))
        return res({ name: "Drip Dragon #1347", image: "ipfs://bafyimg/1347.png" });
      return res({});
    };
    const readUris = async (_c: any, its: any[]) => its.map(() => NEW);
    const r = await verifyMetadata(await chain(), [item()], [], { fetchImpl: f as any, readUris });
    expect(r.items[0]).toMatchObject({
      name: "Drip Dragon #1347",
      image: "https://gateway.pinata.cloud/ipfs/bafyimg/1347.png",
      meta: { via: "tokenuri", fixed: true },
    });
    const before = calls;
    // Indexer still stale on the next scan: reuse the stored fix, no API calls.
    const again = await verifyMetadata(await chain(), [item()], r.items, { fetchImpl: f as any, readUris });
    expect(again.items[0].name).toBe("Drip Dragon #1347");
    expect(calls).toBe(before);
  });

  it("keeps indexer data when the chain read fails or the URI is unchanged (immutable ipfs placeholder: no fetch)", async () => {
    const { verifyMetadata } = await import("../src/core/nft/metadata.js");
    let calls = 0;
    const f = async () => {
      calls++;
      return res({});
    };
    const failed = await verifyMetadata(await chain(), [item()], [], {
      fetchImpl: f as any,
      readUris: async () => {
        throw new Error("rpc down");
      },
    });
    expect(failed.items[0].name).toBe("Pre reveal");
    const same = await verifyMetadata(await chain(), [item()], [], {
      fetchImpl: f as any,
      recheckPlaceholders: true,
      readUris: async (_c, its) => its.map(() => OLD),
    });
    expect(same.items[0]).toMatchObject({ name: "Pre reveal", meta: { uri: OLD } });
    expect(same.placeholders).toBe(1);
    expect(calls).toBe(0);
  });

  it("re-reads mutable (https) placeholder metadata on recheck", async () => {
    const { verifyMetadata } = await import("../src/core/nft/metadata.js");
    const uri = "https://meta.example.com/token/1347";
    const f = async (u: string) =>
      u === uri ? res({ name: "Drip Dragon #1347", image: "https://cdn.example.com/1347.png" }) : res({}, false);
    const r = await verifyMetadata(await chain(), [item({ tokenUri: uri })], [], {
      fetchImpl: f as any,
      recheckPlaceholders: true,
      readUris: async (_c, its) => its.map(() => uri),
    });
    expect(r.items[0]).toMatchObject({ name: "Drip Dragon #1347", image: "https://cdn.example.com/1347.png" });
    expect(r.placeholders).toBe(0);
  });

  it("parses data: JSON token URIs", async () => {
    const { metadataFromUri } = await import("../src/core/nft/metadata.js");
    const j = Buffer.from(JSON.stringify({ name: "On-chain #1", image: "data:image/svg+xml;base64,AAA" })).toString("base64");
    expect(await metadataFromUri(`data:application/json;base64,${j}`, (async () => res({})) as any)).toEqual({
      name: "On-chain #1",
      image: null,
    });
  });
});

describe("holdings + housekeeping metadata re-check", () => {
  it("schedules placeholders and repairs them in the background without an indexer scan", async () => {
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    const db = client.getDb();
    const schema = await import("../src/db/schema.js");
    const now = new Date().toISOString();
    await db
      .insert(schema.users)
      .values({ id: "mu", privyUserId: "did:privy:mu", role: "user", disabled: false, createdAt: now, lastSeenAt: now } as any);
    await db.insert(schema.wallets).values({
      id: "mw1",
      userId: "mu",
      privyWalletId: "pm1",
      address: "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0",
      label: "one",
      source: "privy",
      isMain: true,
      createdAt: now,
    } as any);
    const holdings = await import("../src/core/nft/holdings.js");
    const { verifyMetadata } = await import("../src/core/nft/metadata.js");
    let onchain = OLD;
    let scans = 0;
    const scan = async (c: any) => {
      scans++;
      return { source: "alchemy" as const, truncated: false, items: c.key === "robinhood" ? [item()] : [] };
    };
    const verify = ((c: any, items: any, prev: any, o: any) =>
      verifyMetadata(c, items, prev, {
        ...o,
        readUris: async (_c, its) => its.map(() => onchain),
        fetchImpl: (async (u: string) =>
          u.includes("pinata") ? res({ name: "Drip Dragon #1347", image: "https://cdn.example.com/1347.png" }) : res({}, false)) as any,
      })) as any;
    await holdings.refreshHoldings("mu", "missing", { scan: scan as any, verify });
    const due = await db.select().from(schema.nftMetaDue);
    expect(due.map((d: any) => d.id)).toEqual(["mw1:robinhood"]);
    // Not due yet → nothing happens.
    expect((await holdings.recheckDueMetadata({ verify })).checked).toBe(0);
    // Collection reveals (baseURI changed on-chain); an hour later housekeeping repairs it.
    onchain = NEW;
    const scansBefore = scans;
    const r = await holdings.recheckDueMetadata({ verify, now: Date.now() + 2 * 3_600_000 });
    expect(r).toMatchObject({ checked: 1, fixed: 1 });
    expect(scans).toBe(scansBefore); // no indexer call
    const v = await holdings.holdingsView("mu");
    expect(v.items.find((i) => i.chain === "robinhood")).toMatchObject({ name: "Drip Dragon #1347" });
    expect(await db.select().from(schema.nftMetaDue)).toHaveLength(0); // nothing left to watch
  });
});
