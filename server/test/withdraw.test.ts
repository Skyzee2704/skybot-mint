// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Transaction, Wallet, toBeHex } from "ethers";
import {
  EOA_TRANSFER_GAS,
  assembleAndVerify,
  computeSweep,
  l1SizedTx,
  parseAmount,
  signQuote,
  validateDestination,
  type UnsignedWithdrawTx,
} from "../src/core/withdraw.js";

const gwei = 10n ** 9n;

describe("max sweep fee math", () => {
  it("EOA sweep on L1-style chains leaves exactly 0 (fee = 21000 × gasPrice)", () => {
    const balance = 123_456_789_000_000_000n;
    const r = computeSweep({ balance, gasLimit: EOA_TRANSFER_GAS, gasPrice: 3n * gwei, amount: { kind: "max" } });
    expect(r.skip).toBeNull();
    expect(r.fee).toBe(21_000n * 3n * gwei);
    expect(r.value + r.fee).toBe(balance);
    expect(r.leftover).toBe(0n);
  });

  it("OP Stack: reserves the L1 data fee with a 20% buffer (never under-reserves)", () => {
    const balance = 10n ** 16n;
    const l1Fee = 1_234_567n;
    const r = computeSweep({ balance, gasLimit: 21_000n, gasPrice: 1_000_000n, l1Fee, amount: { kind: "max" } });
    expect(r.l1Reserve).toBe((l1Fee * 120n + 99n) / 100n);
    expect(r.l1Reserve >= l1Fee).toBe(true);
    expect(r.value).toBe(balance - 21_000n * 1_000_000n - r.l1Reserve);
    // Worst case leftover after inclusion is only the unused buffer.
    expect(balance - r.value - 21_000n * 1_000_000n - l1Fee).toBe(r.l1Reserve - l1Fee);
  });

  it("skips a wallet whose balance does not cover the fee", () => {
    const fee = 21_000n * 2n * gwei;
    expect(computeSweep({ balance: fee, gasLimit: 21_000n, gasPrice: 2n * gwei, amount: { kind: "max" } }).skip).toMatch(/does not cover/);
    expect(computeSweep({ balance: 0n, gasLimit: 21_000n, gasPrice: 2n * gwei, amount: { kind: "max" } }).skip).toMatch(/does not cover/);
  });

  it("exact amounts must leave room for the fee", () => {
    const ok = computeSweep({ balance: 10n ** 18n, gasLimit: 21_000n, gasPrice: gwei, amount: { kind: "exact", wei: 5n * 10n ** 17n } });
    expect(ok.skip).toBeNull();
    expect(ok.leftover).toBe(10n ** 18n - 5n * 10n ** 17n - 21_000n * gwei);
    const bad = computeSweep({ balance: 10n ** 18n, gasLimit: 21_000n, gasPrice: gwei, amount: { kind: "exact", wei: 10n ** 18n } });
    expect(bad.skip).toMatch(/insufficient/);
  });

  it("L1-priced bytes are a signed-size legacy tx", () => {
    const raw = l1SizedTx({
      to: "0x000000000000000000000000000000000000dEaD",
      value: 10n ** 18n,
      nonce: 7,
      gasLimit: 21_000n,
      gasPrice: gwei,
      chainId: 8453,
    });
    const t = Transaction.from(raw);
    expect(t.type).toBe(0);
    expect(t.chainId).toBe(8453n);
    expect(t.signature).not.toBeNull();
  });
});

describe("withdraw validation", () => {
  it("destination: checksum, case, zero address", () => {
    const good = "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0";
    expect(validateDestination(good)).toBe(good);
    expect(validateDestination(good.toLowerCase())).toBe(good);
    expect(() => validateDestination("0x668b4B1631c9cE86175Af9ED7ac344f0f79927A0")).toThrow(/checksum/);
    expect(() => validateDestination("0x0000000000000000000000000000000000000000")).toThrow(/zero address/);
    expect(() => validateDestination("vitalik.eth")).toThrow(/0x address/);
    expect(() => validateDestination("0x1234")).toThrow(/0x address/);
  });

  it("amount parsing is exact (no float rounding)", () => {
    expect(parseAmount("max")).toEqual({ kind: "max" });
    expect(parseAmount("0.1")).toEqual({ kind: "exact", wei: 10n ** 17n });
    expect(parseAmount("1.000000000000000001")).toEqual({ kind: "exact", wei: 10n ** 18n + 1n });
    expect(() => parseAmount("-1")).toThrow();
    expect(() => parseAmount("1e18")).toThrow();
  });

  it("only broadcasts the exact quoted transfer, signed by the user's wallet", async () => {
    const secret = Buffer.alloc(32, 7);
    const w = Wallet.createRandom();
    const tx: UnsignedWithdrawTx = {
      type: 0,
      chainId: 1,
      to: "0x000000000000000000000000000000000000dEaD",
      value: toBeHex(10n ** 17n),
      nonce: 3,
      gasLimit: toBeHex(21_000n),
      gasPrice: toBeHex(gwei),
      data: "0x",
    };
    const exp = Date.now() + 60_000;
    const quoteToken = signQuote(secret, "u1", "w1", w.address, tx, exp);
    const signed = await w.signTransaction({
      ...tx,
      value: BigInt(tx.value),
      gasLimit: BigInt(tx.gasLimit),
      gasPrice: BigInt(tx.gasPrice),
    });
    const base = { secret, userId: "u1", walletId: "w1", from: w.address, tx, quoteToken };
    expect(assembleAndVerify({ ...base, signed }).raw).toBe(signed);

    // 65-byte signature only (attached to the quoted tx)
    const sigOnly = Transaction.from(signed).signature!.serialized;
    expect(assembleAndVerify({ ...base, signed: sigOnly }).raw).toBe(signed);

    // Different destination signed by the same wallet → rejected
    const evil = await w.signTransaction({
      ...tx,
      to: "0x1111111111111111111111111111111111111111",
      value: BigInt(tx.value),
      gasLimit: 21_000n,
      gasPrice: gwei,
    });
    expect(() => assembleAndVerify({ ...base, signed: evil })).toThrow(/differs/);
    // Quote for another user / tampered tx → rejected
    expect(() => assembleAndVerify({ ...base, userId: "u2", signed })).toThrow(/match/);
    expect(() => assembleAndVerify({ ...base, tx: { ...tx, value: toBeHex(10n ** 18n) }, signed })).toThrow(/match/);
    // Signed by another wallet → rejected
    const other = await Wallet.createRandom().signTransaction({ ...tx, value: BigInt(tx.value), gasLimit: 21_000n, gasPrice: gwei });
    expect(() => assembleAndVerify({ ...base, signed: other })).toThrow(/differs/);
    // Expired
    expect(() => assembleAndVerify({ ...base, signed, now: exp + 1 })).toThrow(/expired/);
  });
});
