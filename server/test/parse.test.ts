// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { parseInput } from "../src/core/resolver/parseInput.js";
import { getChain, rpcsForChain, CHAINS } from "../src/config/chains.js";

const A = "0x06ea2bf75bedc071be4c20361656c665145b38d4";
describe("parseInput", () => {
  it("raw address", () => expect(parseInput(A)).toMatchObject({ kind: "address", value: A }));
  it("opensea collection", () =>
    expect(parseInput("https://opensea.io/collection/cool-cats/overview")).toMatchObject({ kind: "slug", value: "cool-cats" }));
  it("opensea chain-prefixed collection", () =>
    expect(parseInput("https://opensea.io/base/collection/foo")).toMatchObject({ kind: "slug", value: "foo", chainHint: "base" }));
  it("opensea item", () =>
    expect(parseInput(`https://opensea.io/item/base/${A}/12`)).toMatchObject({
      kind: "address",
      value: A,
      chainHint: "base",
      tokenId: "12",
    }));
  it("opensea assets matic", () => expect(parseInput(`https://opensea.io/assets/matic/${A}/1`)).toMatchObject({ chainHint: "polygon" }));
  it("explorer url", () =>
    expect(parseInput(`https://basescan.org/address/${A}#code`)).toMatchObject({ kind: "address", chainHint: "base" }));
  it("bare slug", () => expect(parseInput("My-Drop")).toMatchObject({ kind: "slug", value: "my-drop" }));
  it("garbage", () => expect(() => parseInput("hello world!!")).toThrow());
  it("empty", () => expect(() => parseInput("  ")).toThrow());
});

describe("chains", () => {
  it("has the 9 configured chains with unique ids", () => {
    expect(CHAINS.map((c) => c.key).sort()).toEqual([
      "arbitrum",
      "arc",
      "base",
      "bnb",
      "ethereum",
      "ink",
      "polygon",
      "robinhood",
      "unichain",
    ]);
    expect(new Set(CHAINS.map((c) => c.chainId)).size).toBe(CHAINS.length);
  });
  it("aliases", () => {
    expect(getChain("matic")?.key).toBe("polygon");
    expect(getChain("bsc")?.key).toBe("bnb");
    expect(getChain(8453)?.key).toBe("base");
    expect(getChain("5042")?.key).toBe("arc");
  });
  it("private RPC env takes priority, public fallback kept, send-only appended", () => {
    const base = getChain("base")!;
    const r = rpcsForChain(base, { RPC_BASE: "https://base-mainnet.example/v2/SECRET" } as any);
    expect(r.read[0]).toBe("https://base-mainnet.example/v2/SECRET");
    expect(r.read).toContain("https://mainnet.base.org");
    expect(r.send).toContain("https://mainnet-sequencer.base.org");
    expect(r.hasPrivate).toBe(true);
    const r2 = rpcsForChain(base, { RPC_BASE: "https://x/v2/k", DISABLE_PUBLIC_RPCS_BASE: "true" } as any);
    expect(r2.read).toEqual(["https://x/v2/k"]);
  });
});
