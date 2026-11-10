// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, formatEther, getAddress } from "ethers";
import { normalizeAuthKey } from "../src/auth/authKey.js";
import {
  TEST_SEND_DESTINATION,
  TEST_SEND_ETH_USD,
  TEST_SEND_VALUE_WEI,
  TEST_SEND_WALLET_ID,
  assertSendValue,
  assertSignedNativeTransfer,
  assertSourceWalletAddress,
  assertTestSendToken,
  runTestNativeSend,
  siweTestAuthorizationContext,
  testSendFailure,
} from "../src/testsend/nativeSend.js";

const prevEnv = {
  TEST_SEND_TOKEN: process.env.TEST_SEND_TOKEN,
  PRIVY_SIWE_AUTH_PRIVATE_KEY: process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY,
  PRIVY_SIWE_KEY_QUORUM_ID: process.env.PRIVY_SIWE_KEY_QUORUM_ID,
  PRIVY_AUTH_PRIVATE_KEY: process.env.PRIVY_AUTH_PRIVATE_KEY,
};

afterEach(() => {
  for (const [name, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const matchingAddress = getAddress(`0xB22${"0".repeat(33)}4D2F`);

describe("test send constants", () => {
  it("keeps the destination checksum and the $0.10 wei amount", () => {
    expect(TEST_SEND_DESTINATION).toBe("0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877");
    expect(getAddress(TEST_SEND_DESTINATION)).toBe(TEST_SEND_DESTINATION);
    expect(TEST_SEND_VALUE_WEI).toBe(48646650191668n);
    expect(formatEther(TEST_SEND_VALUE_WEI)).toBe("0.000048646650191668");
    const priceCents = BigInt(TEST_SEND_ETH_USD.replace(".", ""));
    const cents = (TEST_SEND_VALUE_WEI * priceCents + 10n ** 18n / 2n) / 10n ** 18n;
    expect(cents).toBe(10n);
  });
});

describe("test send gate", () => {
  it("is disabled when TEST_SEND_TOKEN is unset and does not call Privy", async () => {
    delete process.env.TEST_SEND_TOKEN;
    await expect(runTestNativeSend("anything")).rejects.toMatchObject({ code: "TEST_SEND_DISABLED", statusCode: 503 });
    expect(() => assertTestSendToken("x")).toThrow(/TEST_SEND_TOKEN is not set/);
  });

  it("refuses to sign with the mint key when the SIWE key is missing", async () => {
    process.env.TEST_SEND_TOKEN = "desk-token-value";
    process.env.PRIVY_AUTH_PRIVATE_KEY = "mint-key-present";
    delete process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY;
    delete process.env.PRIVY_SIWE_KEY_QUORUM_ID;
    await expect(runTestNativeSend("desk-token-value")).rejects.toMatchObject({
      code: "TEST_SEND_SIGNING_NOT_CONFIGURED",
      statusCode: 503,
    });
  });

  it("builds the authorization context from the SIWE key, not the mint key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY = `wallet-auth:${pem}`;
    process.env.PRIVY_SIWE_KEY_QUORUM_ID = "siwe-quorum-id";
    process.env.PRIVY_AUTH_PRIVATE_KEY = "mint-key-must-not-appear";
    const ctx = siweTestAuthorizationContext();
    expect(ctx.authorization_private_keys).toEqual([normalizeAuthKey(pem)]);
    expect(JSON.stringify(ctx)).not.toContain("mint-key-must-not-appear");
    expect(JSON.stringify(ctx)).not.toContain("siwe-quorum-id");
    expect(ctx.authorization_private_keys[0]).not.toContain("BEGIN");
    delete process.env.PRIVY_SIWE_KEY_QUORUM_ID;
    expect(() => siweTestAuthorizationContext()).toThrow(/PRIVY_SIWE_KEY_QUORUM_ID/);
  });

  it("rejects a missing or wrong token without echoing it", () => {
    process.env.TEST_SEND_TOKEN = "desk-token-value";
    expect(() => assertTestSendToken(null)).toThrow(/Unauthorized/);
    expect(() => assertTestSendToken("nope")).toThrow(/Unauthorized/);
    try {
      assertTestSendToken("wrong-token");
    } catch (e: any) {
      expect(e.statusCode).toBe(401);
      expect(e.message).not.toContain("desk-token-value");
      expect(e.message).not.toContain("wrong-token");
    }
    expect(() => assertTestSendToken("desk-token-value")).not.toThrow();
  });
});

describe("source wallet address", () => {
  it("accepts only 0xB22…4D2F", () => {
    expect(assertSourceWalletAddress(matchingAddress)).toBe(matchingAddress);
    expect(assertSourceWalletAddress(matchingAddress.toLowerCase())).toBe(matchingAddress);
    expect(() => assertSourceWalletAddress("0x" + "ab".repeat(20))).toThrow(/0xB22/);
    expect(() => assertSourceWalletAddress(`0xB22${"0".repeat(33)}4D2E`)).toThrow(/4D2F/);
    expect(() => assertSourceWalletAddress("0xB224D2F")).toThrow(/20-byte/);
    expect(TEST_SEND_WALLET_ID).toBe("tloqxjloa5jloj6dv38n0fmf");
  });
});

describe("value cap", () => {
  it("allows only the hardcoded wei amount", () => {
    expect(() => assertSendValue(TEST_SEND_VALUE_WEI)).not.toThrow();
    expect(() => assertSendValue(TEST_SEND_VALUE_WEI + 1n)).toThrow(/above the hardcoded cap/);
    expect(() => assertSendValue(10n ** 18n)).toThrow(/cap/);
    expect(() => assertSendValue(TEST_SEND_VALUE_WEI - 1n)).toThrow(/only allowed amount/);
    expect(() => assertSendValue(0n)).toThrow(/cap/);
  });
});

describe("signed native transfer", () => {
  const signer = Wallet.createRandom();
  const from = signer.address;

  async function sign(over: Partial<{ value: bigint; to: string; data: string; chainId: number }>) {
    return signer.signTransaction({
      type: 2,
      chainId: over.chainId ?? 1,
      to: over.to ?? TEST_SEND_DESTINATION,
      value: over.value ?? TEST_SEND_VALUE_WEI,
      data: over.data ?? "0x",
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
  }

  it("accepts the exact native transfer and rejects every other shape", async () => {
    const ok = await sign({});
    expect(assertSignedNativeTransfer(ok, from)).toMatchObject({
      from: getAddress(from),
      to: TEST_SEND_DESTINATION,
      value: TEST_SEND_VALUE_WEI,
      data: "0x",
      chainId: 1,
    });
    await expect(sign({ value: TEST_SEND_VALUE_WEI + 1n }).then((raw) => assertSignedNativeTransfer(raw, from))).rejects.toThrow(/cap/);
    await expect(sign({ to: from }).then((raw) => assertSignedNativeTransfer(raw, from))).rejects.toThrow(/Refusing to broadcast to/);
    await expect(sign({ data: "0xa9059cbb" }).then((raw) => assertSignedNativeTransfer(raw, from))).rejects.toThrow(/calldata/);
    await expect(sign({ chainId: 8453 }).then((raw) => assertSignedNativeTransfer(raw, from))).rejects.toThrow(/chain id/);
    expect(() => assertSignedNativeTransfer(ok, matchingAddress)).toThrow(/does not match/);
  });
});

describe("error scrubbing", () => {
  it("drops the gate token and authorization key material", () => {
    process.env.TEST_SEND_TOKEN = "super-secret-token";
    const f = testSendFailure({
      status: 400,
      message: "400 policy denied super-secret-token wallet-auth:AAAA",
      error: { message: "policy denied", code: "policy_violation", authorization_private_keys: ["nope"] },
    });
    expect(f.status).toBe(400);
    expect(f.message).toContain("policy denied");
    expect(f.message).toContain("policy_violation");
    expect(f.message).not.toContain("super-secret-token");
    expect(f.message).not.toContain("wallet-auth:AAAA");
    expect(f.message).not.toContain("nope");
  });

  it("keeps a Privy policy denial verbatim", () => {
    const denial = "Policy violation: eth_signTransaction is not allowed by policy pol_abc";
    const f = testSendFailure({
      status: 400,
      message: `400 ${denial}`,
      error: { code: "policy_violation", error: denial },
    });
    expect(f.status).toBe(400);
    expect(f.message).toContain(denial);
    expect(f.message).toContain("policy_violation");
  });
});
