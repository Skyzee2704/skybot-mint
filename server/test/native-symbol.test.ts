// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseEther } from "ethers";
import { nativeText } from "../src/util/native.js";
import { paymentSymbolOf } from "../src/core/resolver/resolver.js";
import { priceText } from "../src/bot/format.js";
import { formatWalletBalances } from "../src/bot/wallets.js";
import { gasShortfallMessage } from "../src/core/tx/revert.js";
import { fmtNative } from "../../web/lib/api.js";
import { planFund } from "../src/core/fund.js";
import { computeSweep } from "../src/core/withdraw.js";

describe("native symbols", () => {
  it("formats an Elysium balance as HYPE and an Arc balance as USDC", () => {
    expect(nativeText(parseEther("1.25"), "HYPE")).toBe("1.25 HYPE");
    expect(nativeText(parseEther("100"), "USDC")).toBe("100 USDC");
    expect(fmtNative("1250000000000000000", "HYPE", 6)).toBe("1.25 HYPE");
    expect(fmtNative("100000000000000000000", "USDC", 6)).toBe("100 USDC");
    expect(gasShortfallMessage(parseEther("0.2"), parseEther("0.1"), "HYPE")).toBe(
      "Not enough HYPE for gas: need 0.2 HYPE, have 0.1 HYPE.",
    );
  });

  it("keeps an ERC-20 mint price on its token and native amounts on the chain symbol", () => {
    expect(paymentSymbolOf({ price_currency_address: "0x0000000000000000000000000000000000000000" })).toBeNull();
    expect(paymentSymbolOf({ price_currency: { symbol: "WHYPE", address: "0xba876237b0f021a6c6d852d6c26e107997cc5e81" } })).toBe("WHYPE");
    expect(priceText({ priceWei: "180000000000000000", paymentSymbol: "WHYPE" }, "HYPE")).toBe("0.18 WHYPE");
    expect(priceText({ priceWei: "180000000000000000", paymentSymbol: null }, "HYPE")).toBe("0.18 HYPE");
  });

  it("lists each chain's balance with its own symbol and does not add them", () => {
    const text = formatWalletBalances(
      [{ label: "Main", address: "0x" + "ab".repeat(20), isMain: true }],
      [
        { address: "0x" + "ab".repeat(20), chain: "Elysium", symbol: "HYPE", wei: parseEther("2") },
        { address: "0x" + "ab".repeat(20), chain: "Arc", symbol: "USDC", wei: parseEther("3") },
        { address: "0x" + "ab".repeat(20), chain: "Base", symbol: "ETH", wei: 0n },
      ],
    );
    expect(text).toContain("2 HYPE on Elysium");
    expect(text).toContain("3 USDC on Arc");
    expect(text).not.toContain("5 ");
    expect(text).not.toMatch(/HYPE on Arc|USDC on Elysium/);
  });

  it("puts the chain symbol on fund and withdraw shortfalls", () => {
    const fee = 21_000n * 10n ** 9n;
    expect(planFund({ balance: fee, fees: [fee, fee], amount: { kind: "max" }, symbol: "HYPE" }).error).toMatch(/HYPE/);
    expect(computeSweep({ balance: fee, gasLimit: 21_000n, gasPrice: 10n ** 9n, amount: { kind: "max" }, symbol: "USDC" }).skip).toMatch(
      /USDC/,
    );
  });
});
