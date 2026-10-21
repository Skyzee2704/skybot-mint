// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { DANGEROUS_SELECTORS, isDangerousFunctionName } from "../src/core/safety/safety.js";
import { computeFees } from "../src/core/mint/fees.js";
import { redact, redactString } from "../src/util/log.js";
import { getChain } from "../src/config/chains.js";

const NFT = "0x06ea2bf75bedc071be4c20361656c665145b38d4";
const approve = new Interface(["function setApprovalForAll(address,bool)"]).encodeFunctionData("setApprovalForAll", [NFT, true]);

describe("dangerous selectors", () => {
  it("blocks approvals", () => {
    expect(DANGEROUS_SELECTORS[approve.slice(0, 10).toLowerCase()]).toMatch(/setApprovalForAll/);
    expect(isDangerousFunctionName("transferFrom")).toBe(true);
    expect(isDangerousFunctionName("mint")).toBe(false);
  });
});

describe("fees", () => {
  it("applies mode and cap", () => {
    const f = computeFees(10_000_000_000n, 1_000_000_000n, "normal", 100_000_000_000n);
    expect(f.maxPriorityFeePerGas).toBe(1_250_000_000n);
  });
});

describe("redaction", () => {
  it("masks alchemy paths and bot tokens", () => {
    expect(redactString("fail https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123 timeout")).toBe(
      "fail https://eth-mainnet.g.alchemy.com/*** timeout",
    );
    expect(redactString("err 1234567890:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll x")).toBe("err [REDACTED_BOT_TOKEN] x");
    expect(redact({ password: "x", ok: 1 })).toEqual({ password: "[REDACTED]", ok: 1 });
  });
  it("knows base chain", () => expect(getChain("base")?.chainId).toBe(8453));
});
