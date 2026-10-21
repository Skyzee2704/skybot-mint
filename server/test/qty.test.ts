// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { clampQty, walletMaxQty } from "../src/core/mint/qty.js";
import { explainMintError } from "../src/core/mint/simulate.js";

describe("per-wallet quantity bounds", () => {
  it("limit minus already minted, capped by supply", () => {
    expect(walletMaxQty({ maxPerWallet: 3, minted: 1 })).toBe(2);
    expect(walletMaxQty({ maxPerWallet: 3, minted: 5 })).toBe(0);
    expect(walletMaxQty({ maxPerWallet: 10, minted: 0, supplyRemaining: 4 })).toBe(4);
    expect(walletMaxQty({ maxPerWallet: null, minted: null })).toBe(100);
    expect(walletMaxQty({ maxPerWallet: 191, minted: null })).toBe(191);
  });
  it("clamps steppers and typed values", () => {
    expect(clampQty(5, 2)).toBe(2);
    expect(clampQty(-1, 2)).toBe(0);
    expect(clampQty(1.7, 3)).toBe(1);
    expect(clampQty(Number.NaN, 3)).toBe(1);
    expect(clampQty(Number.NaN, 0)).toBe(0);
  });
});

describe("plain-English simulation reasons", () => {
  it("maps common failures", () => {
    expect(explainMintError("OpenSea: Wallet not on allowlist")).toMatch(/allowlist/);
    expect(explainMintError("MintQuantityExceedsMaxMintedPerWallet(3, 2)")).toMatch(/per-wallet/);
    expect(explainMintError("NotActive(1, 2, 3)")).toMatch(/hasn't started/);
    expect(explainMintError("insufficient funds for gas * price + value")).toMatch(/balance/);
    expect(explainMintError("weird")).toMatch(/^Simulation reverted: weird/);
    expect(explainMintError(null)).toBeNull();
  });
});
