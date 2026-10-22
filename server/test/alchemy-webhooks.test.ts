// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "ethers";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "w".repeat(48);
process.env.PUBLIC_URL = "https://skybot.test";
delete process.env.ALCHEMY_AUTH_TOKEN;
delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const NFT = "0x1111111111111111111111111111111111111111";
const now = () => new Date().toISOString();

function payload(activity: any[], network = "BASE_MAINNET", webhookId = "wh_base") {
  return { webhookId, id: "whevt_1", createdAt: now(), type: "ADDRESS_ACTIVITY", event: { network, activity } };
}

describe("Alchemy signature verification", () => {
  it("accepts the exact HMAC of the raw body and rejects anything else", async () => {
    const { verifyAlchemySignature, signBody } = await import("../src/core/alchemy/webhook.js");
    const raw = JSON.stringify(payload([]));
    const sig = signBody(raw, "whsec_test");
    expect(verifyAlchemySignature(raw, sig, "whsec_test")).toBe(true);
    expect(verifyAlchemySignature(raw, sig.toUpperCase(), "whsec_test")).toBe(true);
    expect(verifyAlchemySignature(raw + " ", sig, "whsec_test")).toBe(false);
    expect(verifyAlchemySignature(raw, sig, "other")).toBe(false);
    expect(verifyAlchemySignature(raw, null, "whsec_test")).toBe(false);
    expect(verifyAlchemySignature(raw, "zz", "whsec_test")).toBe(false);
    expect(verifyAlchemySignature(raw, sig, null)).toBe(false);
  });
});

describe("Address Activity parsing", () => {
  it("classifies native, ERC-20 and NFT transfers per address", async () => {
    const { parseAddressActivity } = await import("../src/core/alchemy/webhook.js");
    const r = parseAddressActivity(
      payload([
        { category: "external", fromAddress: A, toAddress: B, value: 1 },
        { category: "token", fromAddress: B, toAddress: A, rawContract: { address: NFT }, erc721TokenId: "0x2a" },
        { category: "erc20", fromAddress: A, toAddress: "0x0000000000000000000000000000000000000000", rawContract: { address: NFT } },
        {
          category: "erc1155",
          fromAddress: A,
          toAddress: B,
          rawContract: { address: NFT },
          erc1155Metadata: [{ tokenId: "0x1", value: "0x1" }],
        },
        { category: "weird", fromAddress: A },
      ]),
    );
    expect(r.chain).toBe("base");
    const a = r.touches.find((t) => t.address === A)!;
    const b = r.touches.find((t) => t.address === B)!;
    expect([...a.kinds].sort()).toEqual(["erc20", "native", "nft"]);
    expect([...b.kinds].sort()).toEqual(["native", "nft"]);
    expect(b.erc721Out).toEqual([{ contract: getAddress(NFT), tokenId: "42" }]);
    expect(a.erc721Out).toEqual([]);
    expect(r.touches.some((t) => t.address.startsWith("0x00000000000000000000000000000000000000000"))).toBe(false);
  });
  it("ignores unknown networks and other webhook types", async () => {
    const { parseAddressActivity } = await import("../src/core/alchemy/webhook.js");
    expect(parseAddressActivity(payload([{ category: "external", fromAddress: A }], "SOLANA_MAINNET")).touches).toEqual([]);
    expect(parseAddressActivity({ ...payload([]), type: "NFT_ACTIVITY" }).touches).toEqual([]);
  });
});

describe("address sync diffing", () => {
  it("diffs case-insensitively and is stable", async () => {
    const { diffAddresses, addressHash } = await import("../src/core/alchemy/sync.js");
    expect(diffAddresses([A.toUpperCase().replace("0X", "0x"), B], [A, NFT])).toEqual({ add: [NFT.toLowerCase()], remove: [B] });
    expect(diffAddresses([], [])).toEqual({ add: [], remove: [] });
    expect(addressHash([B, A])).toBe(addressHash([A.toUpperCase().replace("0X", "0x"), B, A]));
  });
});

describe("webhook → cache invalidation (DB)", () => {
  let userId = "";
  let walletA = "";
  beforeAll(async () => {
    const { ensureDb, getDb } = await import("../src/db/client.js");
    await ensureDb();
    const { users, wallets, nftHoldings } = await import("../src/db/schema.js");
    userId = "u-wh";
    walletA = "w-a";
    await getDb().insert(users).values({ id: userId, privyUserId: "p-wh", createdAt: now(), lastSeenAt: now() });
    await getDb()
      .insert(wallets)
      .values({ id: walletA, userId, address: getAddress(A), label: "A", source: "privy", createdAt: now() });
    await getDb()
      .insert(wallets)
      .values({ id: "w-removed", userId, address: getAddress(B), label: "B", source: "privy", createdAt: now(), removedAt: now() });
    await getDb()
      .insert(nftHoldings)
      .values({
        id: `${walletA}:base`,
        userId,
        walletId: walletA,
        chain: "base",
        address: getAddress(A),
        itemsJson: JSON.stringify([
          {
            contract: getAddress(NFT),
            tokenId: "42",
            standard: "erc721",
            quantity: "1",
            name: "x",
            collection: null,
            collectionSlug: null,
            image: null,
            spam: false,
          },
          {
            contract: getAddress(NFT),
            tokenId: "43",
            standard: "erc721",
            quantity: "1",
            name: "y",
            collection: null,
            collectionSlug: null,
            image: null,
            spam: false,
          },
        ]),
        scannedAt: now(),
      });
  });

  it("only watches active wallets", async () => {
    const { desiredAddresses } = await import("../src/core/alchemy/sync.js");
    expect(await desiredAddresses()).toEqual([A]);
  });

  it("verified delivery invalidates balances, drops the outgoing ERC-721 and queues one debounced re-scan", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { alchemyWebhooks, nftRescanQueue, walletActivity } = await import("../src/db/schema.js");
    const { seal } = await import("../src/util/secretBox.js");
    const { SIGNING_PURPOSE, clearSigningKeyCache } = await import("../src/core/alchemy/sync.js");
    const { handleAlchemyWebhook, signBody } = await import("../src/core/alchemy/webhook.js");
    const { cachedBalances } = await import("../src/util/balanceCache.js");
    const { activitySince } = await import("../src/core/alchemy/activity.js");
    const { loadRows } = await import("../src/core/nft/holdings.js");
    await getDb()
      .insert(alchemyWebhooks)
      .values({
        network: "BASE_MAINNET",
        webhookId: "wh_base",
        signingKeyEnc: seal(SIGNING_PURPOSE, "whsec_live"),
        addressCount: 1,
        syncedAt: now(),
      });
    clearSigningKeyCache();

    let loads = 0;
    const load = async (m: string[]) => {
      loads++;
      return new Map(m.map((a) => [a, 5n]));
    };
    await cachedBalances("base", [A], load);
    await cachedBalances("base", [A], load);
    expect(loads).toBe(1);

    const raw = JSON.stringify(
      payload([
        { category: "erc721", fromAddress: A, toAddress: NFT, rawContract: { address: NFT }, erc721TokenId: "0x2a" },
        { category: "external", fromAddress: A, toAddress: NFT, value: 0.1 },
      ]),
    );
    // Forged signature: acknowledged (200) but ignored.
    const forged = await handleAlchemyWebhook(raw, signBody(raw, "wrong"));
    expect(forged.status).toBe(200);
    expect(forged.body.ignored).toBe("unverified");
    expect(await getDb().select().from(walletActivity)).toHaveLength(0);

    const r = await handleAlchemyWebhook(raw, signBody(raw, "whsec_live"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, chain: "base", wallets: 1, rescans: 1, removed: 1 });
    expect(typeof r.followUp).toBe("function");
    // Balance cache dropped locally and marked stale for other instances.
    expect((await activitySince("base", [A])).get(A)).toBeGreaterThan(0);
    await cachedBalances("base", [A], load, { changedAt: await activitySince("base", [A]) });
    expect(loads).toBe(2);
    // ERC-721 #42 removed right away, #43 kept.
    const row = (await loadRows(userId)).find((x) => x.chain === "base")!;
    expect(row.items.map((i) => i.tokenId)).toEqual(["43"]);
    // A second delivery in the burst pushes the same queue row forward (debounce), never duplicates it.
    await handleAlchemyWebhook(raw, signBody(raw, "whsec_live"));
    const q = await getDb().select().from(nftRescanQueue);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ walletId: walletA, chain: "base" });
  });

  it("processes only due rows, claims them once, and schedules a second pass", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { nftRescanQueue } = await import("../src/db/schema.js");
    const { processRescanQueue } = await import("../src/core/nft/rescan.js");
    const calls: string[] = [];
    const rescan = async (_u: string, w: string, c: string) => {
      calls.push(`${w}:${c}`);
      return "scanned" as const;
    };
    expect(await processRescanQueue({ rescan })).toEqual({ scanned: 0, failed: 0, skipped: 0 }); // not due yet
    const later = Date.now() + 20_000;
    expect(await processRescanQueue({ now: later, rescan })).toMatchObject({ scanned: 1 });
    expect(await processRescanQueue({ now: later, rescan })).toMatchObject({ scanned: 0 });
    expect(calls).toEqual([`${walletA}:base`]);
    const q = await getDb().select().from(nftRescanQueue);
    expect(q).toHaveLength(1);
    expect(Number(q[0].pass)).toBe(2);
    await processRescanQueue({ now: later + 61_000, rescan });
    expect(calls).toHaveLength(2);
    expect(await getDb().select().from(nftRescanQueue)).toHaveLength(0);
  });

  it("sync adopts an existing webhook (our URL + network), fixes its addresses and stores the key encrypted", async () => {
    process.env.ALCHEMY_AUTH_TOKEN = "test-token";
    const { getDb } = await import("../src/db/client.js");
    const { alchemyWebhooks } = await import("../src/db/schema.js");
    const { syncAlchemyWebhooks, signingKeyFor, clearSigningKeyCache } = await import("../src/core/alchemy/sync.js");
    await getDb().delete(alchemyWebhooks);
    const calls: { method: string; url: string; body?: any }[] = [];
    let created = 0;
    const f = async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, url, body });
      const ok = (j: any) => ({ ok: true, status: 200, json: async () => j });
      if (url.endsWith("/team-webhooks"))
        return ok({
          data: [
            {
              id: "wh_existing",
              network: "BASE_MAINNET",
              webhook_type: "ADDRESS_ACTIVITY",
              webhook_url: "https://skybot.test/api/webhooks/alchemy",
              is_active: true,
              signing_key: "whsec_adopted",
            },
            {
              id: "wh_other",
              network: "ETH_MAINNET",
              webhook_type: "ADDRESS_ACTIVITY",
              webhook_url: "https://elsewhere/hook",
              is_active: true,
              signing_key: "x",
            },
          ],
        });
      if (url.includes("/webhook-addresses"))
        return ok({ data: ["0x0d6aea8554094d7088a7f22db0aed0bf106a2bb7"], pagination: { cursors: {} } });
      if (url.endsWith("/create-webhook")) {
        created++;
        return ok({
          data: {
            id: `wh_new_${body.network}`,
            network: body.network,
            webhook_url: body.webhook_url,
            is_active: true,
            signing_key: `whsec_${body.network}`,
          },
        });
      }
      return ok({});
    };
    const r = await syncAlchemyWebhooks({ mode: "full", fetchImpl: f as any });
    const base = r.networks.find((n) => n.network === "BASE_MAINNET")!;
    expect(base).toMatchObject({ webhookId: "wh_existing", status: "updated (+1 / -1)" });
    expect(created).toBe(8); // every other network, none for Base, the foreign ETH webhook is not reused
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      webhook_id: "wh_existing",
      addresses_to_add: [A],
      addresses_to_remove: ["0x0d6aea8554094d7088a7f22db0aed0bf106a2bb7"],
    });
    const row = (await getDb().select().from(alchemyWebhooks)).find((x) => x.network === "BASE_MAINNET")!;
    expect(row.signingKeyEnc).toBeTruthy();
    expect(row.signingKeyEnc).not.toContain("whsec_adopted");
    clearSigningKeyCache();
    expect(await signingKeyFor("wh_existing")).toBe("whsec_adopted");
    // auto mode: nothing changed → no Alchemy calls at all.
    const before = calls.length;
    await syncAlchemyWebhooks({ mode: "auto", fetchImpl: f as any });
    expect(calls.length).toBe(before);
    delete process.env.ALCHEMY_AUTH_TOKEN;
    expect((await syncAlchemyWebhooks({ fetchImpl: f as any })).status).toMatch(/disabled/);
  });
});
