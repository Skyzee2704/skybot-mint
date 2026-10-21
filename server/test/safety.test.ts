import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
import { parseEther, Interface } from "ethers";
import { assertSafeMintTx, assertDailyBudget, recordSpend, settleSpend, dailySpent } from "../src/core/safety/safety.js";
import { getChain } from "../src/config/chains.js";
import { Store } from "../src/core/store.js";
import { computeFees } from "../src/core/mint/fees.js";
import { redact, redactString } from "../src/util/log.js";

const base = getChain("base")!;
const NFT = "0x06ea2bf75bedc071be4c20361656c665145b38d4";
const mint = new Interface(["function mint(uint256) payable"]).encodeFunctionData("mint", [2]);
const approve = new Interface(["function setApprovalForAll(address,bool)"]).encodeFunctionData("setApprovalForAll", [NFT, true]);

const capStore = (on: boolean) => { const st = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmb-")), "db.json")); st.db.settings.priceCapEnabled = on; st.db.settings.dailyCapEnabled = on; return st; };

describe("assertSafeMintTx", () => {
  const ctx = { chain: base, allowedTargets: [NFT], quantity: 2, store: capStore(true) };
  it("allows a normal mint", () => expect(() => assertSafeMintTx({ to: NFT, data: mint, value: parseEther("0.01"), chainId: 8453 }, ctx)).not.toThrow());
  it("blocks approvals/transfers", () => expect(() => assertSafeMintTx({ to: NFT, data: approve, value: 0n, chainId: 8453 }, ctx)).toThrow(/setApprovalForAll/));
  it("blocks unexpected target", () => expect(() => assertSafeMintTx({ to: "0x" + "1".repeat(40), data: mint, value: 0n, chainId: 8453 }, ctx)).toThrow(/target/));
  it("blocks chain mismatch", () => expect(() => assertSafeMintTx({ to: NFT, data: mint, value: 0n, chainId: 1 }, ctx)).toThrow(/Chain ID/));
  it("blocks over max price per NFT", () => expect(() => assertSafeMintTx({ to: NFT, data: mint, value: parseEther("1"), chainId: 8453 }, ctx)).toThrow(/exceeds cap/));
  it("caps are off by default (unlimited price) but chain/target/approve checks stay", () => {
    const off = { ...ctx, store: capStore(false) };
    expect(() => assertSafeMintTx({ to: NFT, data: mint, value: parseEther("100"), chainId: 8453 }, off)).not.toThrow();
    expect(() => assertSafeMintTx({ to: NFT, data: approve, value: 0n, chainId: 8453 }, off)).toThrow(/setApprovalForAll/);
    expect(() => assertSafeMintTx({ to: NFT, data: mint, value: 0n, chainId: 1 }, off)).toThrow(/Chain ID/);
  });
  it("blocks value above published stage price x qty", () => expect(() => assertSafeMintTx({ to: NFT, data: mint, value: parseEther("0.02"), chainId: 8453 }, { ...ctx, store: capStore(false), expectedMaxValueWei: parseEther("0.01") })).toThrow(/stage price/));
});

describe("daily budget", () => {
  let store: Store;
  beforeEach(() => { store = capStore(true); });
  it("is unlimited when disabled", () => { const st = capStore(false); recordSpend(base, parseEther("5"), "x", st); expect(() => assertDailyBudget(base, parseEther("5"), st)).not.toThrow(); });
  it("accumulates and blocks over cap (default 0.25)", () => {
    recordSpend(base, parseEther("0.2"), "a", store);
    expect(dailySpent(base, store)).toBe(parseEther("0.2"));
    expect(() => assertDailyBudget(base, parseEther("0.04"), store)).not.toThrow();
    expect(() => assertDailyBudget(base, parseEther("0.06"), store)).toThrow(/daily spend cap/);
    settleSpend("a", parseEther("0.1"), store);
    expect(() => assertDailyBudget(base, parseEther("0.14"), store)).not.toThrow();
  });
});

describe("fees", () => {
  it("applies mode and cap", () => {
    const f = computeFees(10_000_000_000n, 1_000_000_000n, "normal", 100_000_000_000n);
    expect(f.maxPriorityFeePerGas).toBe(1_250_000_000n);
    expect(f.maxFeePerGas).toBe(21_250_000_000n);
    const c = computeFees(100_000_000_000n, 1_000_000_000n, "aggressive", 50_000_000_000n);
    expect(c.capped).toBe(true); expect(c.maxFeePerGas).toBe(50_000_000_000n);
  });
});

describe("redaction", () => {
  it("masks private keys and RPC url paths", () => {
    expect(redactString(`key 0x${"ab".repeat(32)}`)).not.toContain("ab".repeat(32));
    expect(redactString("fail https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123 timeout")).toBe("fail https://eth-mainnet.g.alchemy.com/*** timeout");
    expect(JSON.stringify(redact({ password: "x", nested: { privateKey: "y" } }))).not.toMatch(/"x"|"y"/);
  });
});
