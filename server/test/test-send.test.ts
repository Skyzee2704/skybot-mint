// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, getAddress } from "ethers";
import { normalizeAuthKey } from "../src/auth/authKey.js";
import { CHAINS, getChain } from "../src/config/chains.js";
import { validateDestination } from "../src/core/withdraw.js";
import {
  TEST_SEND_DEFAULT_WALLET_ID,
  assertSignedNativeTransfer,
  assertTestSendRpc,
  assertTestSendToken,
  assertWalletAllowed,
  parseTestSendAmount,
  parseTestSendBody,
  resolveTestSendChain,
  runTestNativeSend,
  siweTestAuthorizationContext,
  testSendChainOptions,
  testSendFailure,
  testSendWalletAllowlist,
} from "../src/testsend/nativeSend.js";

const prevEnv = {
  TEST_SEND_TOKEN: process.env.TEST_SEND_TOKEN,
  TEST_SEND_WALLET_IDS: process.env.TEST_SEND_WALLET_IDS,
  PRIVY_SIWE_AUTH_PRIVATE_KEY: process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY,
  PRIVY_SIWE_KEY_QUORUM_ID: process.env.PRIVY_SIWE_KEY_QUORUM_ID,
  PRIVY_AUTH_PRIVATE_KEY: process.env.PRIVY_AUTH_PRIVATE_KEY,
  DISABLE_PUBLIC_RPCS_ETHEREUM: process.env.DISABLE_PUBLIC_RPCS_ETHEREUM,
  RPC_ETHEREUM: process.env.RPC_ETHEREUM,
  RPC_URL_ETHEREUM: process.env.RPC_URL_ETHEREUM,
  RPC_URLS_ETHEREUM: process.env.RPC_URLS_ETHEREUM,
};

afterEach(() => {
  for (const [name, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const DEST = "0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877";

describe("test send chains", () => {
  it("uses the repo registry, including the symbols the request left open", () => {
    expect(testSendChainOptions().map((c) => c.chainId)).toEqual(CHAINS.map((c) => c.chainId));
    expect(getChain(4663)?.nativeSymbol).toBe("ETH");
    expect(getChain(4663)?.name).toBe("Robinhood Chain");
    expect(getChain(5042)?.nativeSymbol).toBe("USDC");
    expect(getChain(99901)?.nativeSymbol).toBe("HYPE");
    expect(getChain(56)?.name).toBe("BNB Smart Chain");
    expect(getChain(56)?.nativeSymbol).toBe("BNB");
    expect(getChain(137)?.nativeSymbol).toBe("POL");
    expect(getChain(42161)?.name).toBe("Arbitrum One");
    expect(resolveTestSendChain(1).key).toBe("ethereum");
    expect(() => resolveTestSendChain(999)).toThrow(/Unsupported chain/);
  });

  it("reports a missing RPC instead of inventing one", () => {
    const eth = getChain(1)!;
    expect(() => assertTestSendRpc({ ...eth, key: "norpc", publicRpcs: [] })).toThrow(/RPC not configured for chain Ethereum \(1\)/);
  });
});

describe("test send amount and destination", () => {
  it("accepts any positive decimal and rejects zero or junk", () => {
    expect(parseTestSendAmount("0.0005")).toBe(500000000000000n);
    expect(parseTestSendAmount("10")).toBe(10n * 10n ** 18n);
    expect(() => parseTestSendAmount("0")).toThrow(/greater than 0/);
    expect(() => parseTestSendAmount("max")).toThrow(/greater than 0/);
    expect(() => parseTestSendAmount("1e2")).toThrow(/Invalid amount/);
    expect(() => parseTestSendAmount("-1")).toThrow(/Invalid amount/);
  });

  it("checksums a one-case address and rejects a bad checksum", () => {
    expect(validateDestination(DEST.toLowerCase())).toBe(DEST);
    expect(() => validateDestination("0xdd911fA75E72b3c11e75DCAbfaE9f60D65903878")).toThrow(/checksum/i);
    const body = parseTestSendBody({
      walletId: TEST_SEND_DEFAULT_WALLET_ID,
      chainId: 8453,
      amount: "0.0005",
      destination: DEST.toLowerCase(),
    });
    expect(body.chainId).toBe(8453);
    expect(body.amount).toBe("0.0005");
    expect(() =>
      parseTestSendBody({
        walletId: "abc",
        chainId: "nope",
        amount: 1,
        destination: "",
      }),
    ).toThrow(/Chain is required/);
  });
});

describe("test send allowlist", () => {
  it("defaults to the original wallet and rejects anything else", () => {
    delete process.env.TEST_SEND_WALLET_IDS;
    expect(testSendWalletAllowlist()).toEqual([TEST_SEND_DEFAULT_WALLET_ID]);
    expect(() => assertWalletAllowed("other-wallet")).toThrow(/TEST_SEND_WALLET_IDS/);
    process.env.TEST_SEND_WALLET_IDS = " alpha , beta,alpha ,, ";
    expect(testSendWalletAllowlist()).toEqual(["alpha", "beta"]);
    expect(() => assertWalletAllowed("alpha")).not.toThrow();
    expect(() => assertWalletAllowed(TEST_SEND_DEFAULT_WALLET_ID)).toThrow(/TEST_SEND_WALLET_IDS/);
  });

  it("does not call Privy for a wallet outside the allowlist", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.PRIVY_SIWE_KEY_QUORUM_ID = "siwe-quorum-id";
    process.env.TEST_SEND_TOKEN = "desk-token-value";
    delete process.env.TEST_SEND_WALLET_IDS;
    await expect(
      runTestNativeSend("desk-token-value", {
        walletId: "not-on-the-list",
        chainId: 1,
        amount: "0.0005",
        destination: DEST,
      }),
    ).rejects.toMatchObject({ code: "WALLET_NOT_ALLOWLISTED", statusCode: 400 });
  });
});

describe("test send gate", () => {
  it("is disabled when TEST_SEND_TOKEN is unset and does not call Privy", async () => {
    delete process.env.TEST_SEND_TOKEN;
    await expect(runTestNativeSend("anything", {})).rejects.toMatchObject({ code: "TEST_SEND_DISABLED", statusCode: 503 });
    expect(() => assertTestSendToken("x")).toThrow(/TEST_SEND_TOKEN is not set/);
  });

  it("refuses to sign with the mint key when the SIWE key is missing", async () => {
    process.env.TEST_SEND_TOKEN = "desk-token-value";
    process.env.PRIVY_AUTH_PRIVATE_KEY = "mint-key-present";
    delete process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY;
    delete process.env.PRIVY_SIWE_KEY_QUORUM_ID;
    await expect(runTestNativeSend("desk-token-value", {})).rejects.toMatchObject({
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

describe("signed native transfer", () => {
  const signer = Wallet.createRandom();
  const from = signer.address;
  const value = 10n * 10n ** 18n;

  async function sign(over: Partial<{ value: bigint; to: string; data: string; chainId: number }>) {
    return signer.signTransaction({
      type: 2,
      chainId: over.chainId ?? 8453,
      to: over.to ?? DEST,
      value: over.value ?? value,
      data: over.data ?? "0x",
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
  }

  it("accepts the requested amount with no wei ceiling and rejects a different payload", async () => {
    const expected = { from: getAddress(from), to: getAddress(DEST), value, chainId: 8453 };
    const ok = await sign({});
    expect(assertSignedNativeTransfer(ok, expected)).toMatchObject({ ...expected, data: "0x" });
    await expect(sign({ value: value + 1n }).then((raw) => assertSignedNativeTransfer(raw, expected))).rejects.toThrow(/request amount/);
    await expect(sign({ to: from }).then((raw) => assertSignedNativeTransfer(raw, expected))).rejects.toThrow(/Refusing to broadcast to/);
    await expect(sign({ data: "0xa9059cbb" }).then((raw) => assertSignedNativeTransfer(raw, expected))).rejects.toThrow(/calldata/);
    await expect(sign({ chainId: 1 }).then((raw) => assertSignedNativeTransfer(raw, expected))).rejects.toThrow(/chain id/);
    expect(() => assertSignedNativeTransfer(ok, { ...expected, from: getAddress(DEST) })).toThrow(/does not match/);
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
