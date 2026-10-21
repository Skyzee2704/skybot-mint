import { describe, it, expect } from "vitest";
import { findMintCandidates, findGetters, bytecodeHasSelector } from "../src/core/resolver/abiAnalysis.js";
import { decodePublicDrop, pickFeeRecipient, encodeMintPublic, OPENSEA_FEE_RECIPIENT, SEADROP_ADDRESS } from "../src/core/resolver/seadrop.js";
import { decide } from "../src/core/mint/eligibility.js";
import { parseMintedTokenIds } from "../src/core/mint/receipts.js";
import { id, zeroPadValue, toBeHex, parseEther } from "ethers";

const ABI = [
  "function mint(uint256 quantity) payable",
  "function ownerMint(address to, uint256 qty)",
  "function whitelistMint(uint256 qty, bytes32[] proof) payable",
  "function setPrice(uint256)",
  "function withdraw()",
  "function mintTo(address recipient, uint256 amount) payable",
  "function cost() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxPerWallet() view returns (uint256)",
  "function numberMinted(address) view returns (uint256)",
  "function paused() view returns (bool)",
];

describe("ABI analysis", () => {
  it("ranks public mint first and excludes admin fns", () => {
    const c = findMintCandidates(ABI);
    const names = c.map((x) => x.name);
    expect(names[0]).toBe("mint");
    expect(names).not.toContain("ownerMint");
    expect(names).not.toContain("setPrice");
    const wl = c.find((x) => x.name === "whitelistMint")!;
    expect(wl.supported).toBe(false);
    const mt = c.find((x) => x.name === "mintTo")!;
    expect(mt.inputs.map((i) => i.role)).toEqual(["recipient", "quantity"]);
  });
  it("finds getters", () => {
    expect(findGetters(ABI)).toMatchObject({ price: "cost()", maxSupply: "maxSupply()", totalSupply: "totalSupply()", maxPerWallet: "maxPerWallet()", mintedBy: "numberMinted(address)", paused: "paused()" });
  });
  it("bytecode selector scan", () => {
    expect(bytecodeHasSelector("0x6080...63a0712d68...", "0xa0712d68")).toBe(true);
    expect(bytecodeHasSelector("0x6080", "0xa0712d68")).toBe(false);
  });
});

describe("SeaDrop helpers", () => {
  it("decodes public drop and treats zeros as unset", () => {
    expect(decodePublicDrop([0n, 0n, 0n, 0n, 0n, false])).toBeNull();
    expect(decodePublicDrop([1000n, 10n, 20n, 5n, 1000n, true])).toMatchObject({ mintPriceWei: "1000", maxPerWallet: 5, restrictFeeRecipients: true });
  });
  it("fee recipient selection", () => {
    expect(pickFeeRecipient([], false)).toBe(OPENSEA_FEE_RECIPIENT);
    expect(pickFeeRecipient([], true)).toBeNull();
  });
  it("encodes mintPublic with correct selector", () => {
    expect(encodeMintPublic("0x06ea2bf75bedc071be4c20361656c665145b38d4", OPENSEA_FEE_RECIPIENT, 2).slice(0, 10)).toBe("0x161ac21f");
    expect(SEADROP_ADDRESS).toBe("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
  });
});

describe("eligibility decide", () => {
  const base = { priceWei: parseEther("0.01"), gasCostWei: parseEther("0.001"), desiredQty: 3, supplyRemaining: 100n, stageEnded: false };
  it("caps qty by per-wallet remaining", () => {
    const d = decide({ ...base, balance: parseEther("1"), maxPerWallet: 5, minted: 4 });
    expect(d.suggestedQty).toBe(1); expect(d.reasons).toEqual([]);
  });
  it("flags insufficient balance and limit reached", () => {
    expect(decide({ ...base, balance: 0n, maxPerWallet: 5, minted: 0 }).reasons[0]).toMatch(/insufficient/);
    expect(decide({ ...base, balance: parseEther("1"), maxPerWallet: 2, minted: 2 }).reasons).toContain("per-wallet limit reached");
  });
});

describe("receipt parsing", () => {
  it("extracts ERC-721 mint token ids for the wallet only", () => {
    const c = "0x06ea2bf75bedc071be4c20361656c665145b38d4"; const w = "0x" + "a".repeat(40);
    const T = id("Transfer(address,address,uint256)");
    const z = zeroPadValue("0x", 32);
    const logs = [
      { address: c, topics: [T, z, zeroPadValue(w, 32), toBeHex(7, 32)], data: "0x" },
      { address: c, topics: [T, z, zeroPadValue("0x" + "b".repeat(40), 32), toBeHex(8, 32)], data: "0x" },
      { address: "0x" + "c".repeat(40), topics: [T, z, zeroPadValue(w, 32), toBeHex(9, 32)], data: "0x" },
    ];
    expect(parseMintedTokenIds(logs, c, w)).toEqual(["7"]);
  });
});
