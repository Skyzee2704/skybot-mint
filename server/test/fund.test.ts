// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";

const E = 10n ** 18n;
const GWEI = 10n ** 9n;

describe("Fund Wallets split math", () => {
  it("splits evenly; the wei remainder stays in Main", async () => {
    const { planFund } = await import("../src/core/fund.js");
    const fee = 21_000n * GWEI;
    const p = planFund({ balance: 1n * E, fees: [fee, fee, fee], amount: { kind: "exact", wei: 100n } });
    expect(p).toMatchObject({ perWallet: 33n, totalValue: 99n, remainder: 1n, totalFee: 3n * fee, error: null });
    expect(p.leftover).toBe(1n * E - 99n - 3n * fee); // includes the 1 wei remainder
  });
  it("Max = balance minus the exact fees of ALL transfers, floor-divided", async () => {
    const { planFund } = await import("../src/core/fund.js");
    const fees = [21_000n * GWEI, 21_000n * GWEI, 23_100n * GWEI];
    const balance = 1n * E + 7n;
    const p = planFund({ balance, fees, amount: { kind: "max" } });
    const total = balance - fees.reduce((a, b) => a + b, 0n);
    expect(p.perWallet).toBe(total / 3n);
    expect(p.remainder).toBe(total % 3n);
    expect(p.totalValue + p.totalFee + p.remainder).toBe(balance);
    expect(p.leftover).toBe(p.remainder); // Main keeps only the rounding dust (fees are paid)
    expect(p.error).toBeNull();
  });
  it("rejects amounts that don't cover the gas, too-small splits and empty selections", async () => {
    const { planFund } = await import("../src/core/fund.js");
    const fee = 21_000n * GWEI;
    // Amount alone fits, amount + gas does not.
    const bal = 10n ** 15n;
    const p = planFund({ balance: bal, fees: [fee, fee], amount: { kind: "exact", wei: bal - fee } });
    expect(p.error).toMatch(/Insufficient Main balance/);
    expect(p.perWallet).toBe(0n);
    expect(planFund({ balance: fee, fees: [fee, fee], amount: { kind: "max" } }).error).toMatch(/does not cover the network fees/);
    expect(planFund({ balance: E, fees: [fee, fee, fee], amount: { kind: "exact", wei: 2n } }).error).toMatch(/too small to split/);
    expect(planFund({ balance: E, fees: [], amount: { kind: "max" } }).error).toMatch(/at least one wallet/);
    expect(planFund({ balance: E, fees: [fee], amount: { kind: "exact", wei: 0n } }).error).toMatch(/greater than 0/);
  });
  it("exact amount that uses the balance to the last wei is allowed", async () => {
    const { planFund } = await import("../src/core/fund.js");
    const fee = 21_000n * GWEI;
    const p = planFund({ balance: 2n * fee + 10n, fees: [fee, fee], amount: { kind: "exact", wei: 10n } });
    expect(p).toMatchObject({ perWallet: 5n, leftover: 0n, error: null });
  });
});

describe("Fund Wallets targets", () => {
  const ws = [
    { id: "a", address: "0x00000000000000000000000000000000000000a1", isMain: false },
    { id: "m", address: "0x00000000000000000000000000000000000000b2", isMain: true },
    { id: "c", address: "0x00000000000000000000000000000000000000c3", isMain: false },
  ];
  it("source is always Main; 'all' = every other wallet in wallet order", async () => {
    const { pickFundTargets } = await import("../src/core/fund.js");
    const r = pickFundTargets(ws, "all");
    expect(r.main.id).toBe("m");
    expect(r.targets.map((w) => w.id)).toEqual(["a", "c"]);
    expect(pickFundTargets(ws, ["c", "a", "c"]).targets.map((w) => w.id)).toEqual(["a", "c"]);
  });
  it("refuses Main as destination, unknown wallets, and accounts without Main", async () => {
    const { pickFundTargets } = await import("../src/core/fund.js");
    expect(() => pickFundTargets(ws, ["m"])).toThrow(/Main wallet is the source/);
    expect(() => pickFundTargets(ws, ["zzz"])).toThrow(/not found/);
    expect(() =>
      pickFundTargets(
        ws.map((w) => ({ ...w, isMain: false })),
        "all",
      ),
    ).toThrow(/Main wallet/);
  });
});

describe("Fund Wallets quote", () => {
  it("builds sequential nonces from Main with HMAC-bound quotes the send path verifies", async () => {
    const { quoteFund } = await import("../src/core/fund.js");
    const { assembleAndVerify } = await import("../src/core/withdraw.js");
    const { requireChain } = await import("../src/config/chains.js");
    const signer = Wallet.createRandom();
    const main = { id: "m", label: "Main", address: signer.address };
    const targets = [
      { id: "a", label: "A", address: Wallet.createRandom().address },
      { id: "b", label: "B", address: Wallet.createRandom().address },
    ];
    const pool: any = {
      read: (fn: any) =>
        fn({
          getBalance: async () => 1n * E,
          getTransactionCount: async () => 7,
          getCode: async () => "0x",
          estimateGas: async () => 21_000n,
        }),
    };
    const secret = Buffer.alloc(32, 9);
    const gasPrice = 2n * GWEI;
    const q = await quoteFund({
      chain: requireChain("ethereum"),
      pool,
      main,
      targets,
      amount: { kind: "max" },
      gasPrice,
      userId: "u",
      secret,
    });
    expect(q.items.map((i) => i.tx.nonce)).toEqual([7, 8]);
    const fee = 21_000n * gasPrice;
    expect(BigInt(q.perWalletWei)).toBe((1n * E - 2n * fee) / 2n);
    expect(q.items.every((i) => i.valueWei === q.perWalletWei)).toBe(true);
    // The browser signs exactly the quoted tx → verifies; a tampered destination doesn't.
    const it0 = q.items[0];
    const signed = await signer.signTransaction({
      ...it0.tx,
      value: BigInt(it0.tx.value),
      gasLimit: BigInt(it0.tx.gasLimit),
      gasPrice: BigInt(it0.tx.gasPrice),
    });
    expect(() =>
      assembleAndVerify({ secret, userId: "u", walletId: "m", from: main.address, tx: it0.tx, quoteToken: it0.quoteToken, signed }),
    ).not.toThrow();
    expect(() =>
      assembleAndVerify({
        secret,
        userId: "u",
        walletId: "m",
        from: main.address,
        tx: { ...it0.tx, to: targets[1].address },
        quoteToken: it0.quoteToken,
        signed,
      }),
    ).toThrow();
  });
});
