// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Interface, ZeroHash, getAddress } from "ethers";
import { parseInput } from "../src/core/resolver/parseInput.js";
import { resolveTarget } from "../src/core/resolver/resolver.js";
import { OpenSeaClient } from "../src/core/resolver/opensea.js";
import { explorerUrl, priceText } from "../src/bot/format.js";

/** Live GET /api/v2/collections/skittersnfts (no API key, 2026-11-09). */
const COLLECTION = {
  collection: "skittersnfts",
  name: "SKITTERS",
  opensea_url: "https://opensea.io/collection/skittersnfts",
  contracts: [{ address: "0xb3ec2c668d23589334b39cf3d7ccc026d9f6315c", chain: "elysium" }],
};

/**
 * Public stage read from SeaDrop.getPublicDrop on Elysium the same day, written in the
 * drops API shape (price wei, ISO times, max_per_wallet). GET /api/v2/drops/skittersnfts
 * itself requires an API key and returned 401 here. Marketplace offers on the public offers
 * endpoint are denominated in WHYPE; this mint price is native HYPE (currency address zero).
 */
const START = "2026-11-09T18:50:05.000Z";
const END = "2026-11-10T18:50:05.000Z";
const DROP = {
  collection_slug: "skittersnfts",
  collection_name: "SKITTERS",
  chain: "elysium",
  contract_address: "0xb3ec2c668d23589334b39cf3d7ccc026d9f6315c",
  drop_type: "seadrop_v1",
  is_minting: false,
  stages: [
    {
      stage_type: "public",
      label: "Public",
      price: "180000000000000000",
      price_currency_address: "0x0000000000000000000000000000000000000000",
      start_time: START,
      end_time: END,
      max_per_wallet: "15",
    },
  ],
  total_supply: "33",
  max_supply: "3333",
};

const NFT = getAddress(COLLECTION.contracts[0].address);
const SEADROP = getAddress("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
const PAYOUT = getAddress("0x09f5ce183734e6d1b019a51e036904a4035163d5");
const FEE = getAddress("0x0000a26b00c1F0DF003000390027140000fAa719");

const token = new Interface([
  "function supportsInterface(bytes4) view returns (bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function getMintStats(address) view returns (uint256,uint256,uint256)",
]);
const seadrop = new Interface([
  "function getPublicDrop(address) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
  "function getAllowedFeeRecipients(address) view returns (address[])",
  "function getAllowListMerkleRoot(address) view returns (bytes32)",
  "function getSigners(address) view returns (address[])",
  "function getCreatorPayoutAddress(address) view returns (address)",
  "function getTokenGatedAllowedTokens(address) view returns (address[])",
]);

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function provider() {
  const call = async (tx: { to?: string; data?: string }) => {
    const data = tx.data ?? "0x";
    const sig = data.slice(0, 10).toLowerCase();
    const to = (tx.to ?? "").toLowerCase();
    if (to === NFT.toLowerCase()) {
      if (sig === token.getFunction("supportsInterface").selector) {
        const [id] = token.decodeFunctionData("supportsInterface", data);
        return token.encodeFunctionResult("supportsInterface", [String(id).toLowerCase() === "0x80ac58cd"]);
      }
      if (sig === token.getFunction("name").selector) return token.encodeFunctionResult("name", ["SKITTERS"]);
      if (sig === token.getFunction("symbol").selector) return token.encodeFunctionResult("symbol", ["SKITTERS"]);
      if (sig === token.getFunction("getMintStats").selector) return token.encodeFunctionResult("getMintStats", [0n, 33n, 3333n]);
    }
    if (to === SEADROP.toLowerCase()) {
      if (sig === seadrop.getFunction("getPublicDrop").selector)
        return seadrop.encodeFunctionResult("getPublicDrop", [
          180000000000000000n,
          BigInt(Date.parse(START) / 1000),
          BigInt(Date.parse(END) / 1000),
          15,
          1000,
          true,
        ]);
      if (sig === seadrop.getFunction("getAllowedFeeRecipients").selector)
        return seadrop.encodeFunctionResult("getAllowedFeeRecipients", [[FEE]]);
      if (sig === seadrop.getFunction("getAllowListMerkleRoot").selector)
        return seadrop.encodeFunctionResult("getAllowListMerkleRoot", [ZeroHash]);
      if (sig === seadrop.getFunction("getSigners").selector) return seadrop.encodeFunctionResult("getSigners", [[]]);
      if (sig === seadrop.getFunction("getCreatorPayoutAddress").selector)
        return seadrop.encodeFunctionResult("getCreatorPayoutAddress", [PAYOUT]);
      if (sig === seadrop.getFunction("getTokenGatedAllowedTokens").selector)
        return seadrop.encodeFunctionResult("getTokenGatedAllowedTokens", [[]]);
    }
    throw Object.assign(new Error(`unhandled call ${sig}`), { code: "CALL_EXCEPTION" });
  };
  return { call, getCode: async () => "0x363d3d373d3d3d363d73" };
}

describe("Elysium OpenSea slug", () => {
  it("resolves the SKITTERS collection URL onto the Elysium contract and its public stage", async () => {
    const input = "https://opensea.io/collection/skittersnfts/overview";
    expect(parseInput(input)).toMatchObject({ kind: "slug", value: "skittersnfts" });
    const seen: string[] = [];
    const os = new OpenSeaClient("test-key", (async (url: string) => {
      seen.push(url);
      if (url.includes("/api/v2/collections/skittersnfts")) return jsonRes(COLLECTION);
      if (url.includes("/api/v2/drops/skittersnfts")) return jsonRes(DROP);
      return jsonRes({ errors: ["unexpected"] }, 404);
    }) as typeof fetch);
    const p = provider();
    const r = await resolveTarget({
      input,
      os,
      poolFor: () => ({ endpoints: [{ provider: p }], checkChainId: async () => {}, read: (fn: any) => fn(p) }) as any,
    });
    expect(seen.map((u) => new URL(u).pathname)).toEqual(["/api/v2/collections/skittersnfts", "/api/v2/drops/skittersnfts"]);
    expect(r.chain).toMatchObject({
      key: "elysium",
      chainId: 99901,
      nativeSymbol: "HYPE",
      explorer: "https://elysium.kinetiq.xyz/explorer",
    });
    expect(r.contract).toBe(NFT);
    expect(r.kind).toBe("seadrop");
    expect(r.slug).toBe("skittersnfts");
    expect(r.name).toBe("SKITTERS");
    expect(r.standard).toBe("erc721");
    expect(r.supply).toEqual({ total: "33", max: "3333", remaining: "3300" });
    expect(r.stages).toEqual([
      expect.objectContaining({
        name: "Public (on-chain)",
        type: "public",
        priceWei: "180000000000000000",
        start: START,
        end: END,
        maxPerWallet: 15,
        source: "onchain",
      }),
    ]);
    expect(["upcoming", "active"]).toContain(r.stages[0].status);
    expect(r.recommendedStrategy).toBe("seadrop_public");
    expect(priceText(r.stages[0], r.chain.nativeSymbol)).toBe("0.18 HYPE");
    expect(r.warnings.join(" ")).not.toMatch(/ERC-20/);
    expect(explorerUrl(r)).toBe(`https://elysium.kinetiq.xyz/explorer/address/${NFT}`);
  });
});
