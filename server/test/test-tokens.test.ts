// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, getAddress } from "ethers";
import { KNOWN_TOKENS } from "../src/testsend/knownTokens.js";
import {
  ERC20_TRANSFER_SELECTOR,
  assertSignedErc20Transfer,
  encodeErc20Transfer,
  formatTokenAmount,
  mergeHeldTokens,
  nonZeroTokenBalances,
  parseErc20Amount,
  runTestErc20Send,
  runTestLookup,
} from "../src/testsend/tokens.js";

const DEST = "0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const prevEnv = {
  TEST_SEND_TOKEN: process.env.TEST_SEND_TOKEN,
  TEST_SEND_WALLET_IDS: process.env.TEST_SEND_WALLET_IDS,
  PRIVY_SIWE_AUTH_PRIVATE_KEY: process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY,
  PRIVY_SIWE_KEY_QUORUM_ID: process.env.PRIVY_SIWE_KEY_QUORUM_ID,
};

afterEach(() => {
  for (const [name, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("known tokens", () => {
  it("includes Binance-Peg USDC and drops a zero balance when merging", () => {
    const usdc = KNOWN_TOKENS.bnb.find((t) => t.symbol === "USDC");
    expect(usdc?.address.toLowerCase()).toBe("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
    for (const list of Object.values(KNOWN_TOKENS)) for (const t of list) expect(getAddress(t.address)).toBe(t.address);
    const row = {
      chainId: 56,
      chainName: "BNB Smart Chain",
      address: usdc!.address,
      symbol: "USDC",
      name: "USDC",
      decimals: 18,
      balanceRaw: "1000",
      balance: "0.000000000000001",
      source: "rpc" as const,
    };
    expect(mergeHeldTokens([], [row]).map((t) => t.symbol)).toEqual(["USDC"]);
    expect(mergeHeldTokens([], [{ ...row, balanceRaw: "0" }])).toEqual([]);
    expect(mergeHeldTokens([{ ...row, source: "alchemy", symbol: "USDC" }], [row])).toHaveLength(1);
  });
});

describe("erc20 transfer encoding", () => {
  it("uses selector 0xa9059cbb and the token decimals", () => {
    const amount = parseErc20Amount("1.5", 6);
    expect(amount).toBe(1_500_000n);
    const data = encodeErc20Transfer(DEST, amount);
    expect(data.toLowerCase().startsWith(ERC20_TRANSFER_SELECTOR)).toBe(true);
    expect(data.length).toBe(2 + 8 + 64 + 64);
    expect(parseErc20Amount("10", 18)).toBe(10n * 10n ** 18n);
    expect(() => parseErc20Amount("0", 6)).toThrow(/greater than 0/);
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("keeps only non-zero Alchemy balances", () => {
    const rows = nonZeroTokenBalances({
      tokenBalances: [
        { contractAddress: "0x0000000000000000000000000000000000000001", tokenBalance: "0x0" },
        { contractAddress: "0x0000000000000000000000000000000000000002", tokenBalance: "0x0a" },
        { contractAddress: "not-an-address", tokenBalance: "0x05" },
      ],
    });
    expect(rows).toEqual([{ contract: getAddress("0x0000000000000000000000000000000000000002"), balance: 10n }]);
  });
});

describe("signed erc20 transfer", () => {
  const signer = Wallet.createRandom();
  const amount = 1_500_000n;
  const data = encodeErc20Transfer(DEST, amount);

  it("accepts value 0 transfer calldata and rejects a different payload", async () => {
    const raw = await signer.signTransaction({
      type: 2,
      chainId: 1,
      to: TOKEN,
      value: 0n,
      data,
      nonce: 0,
      gasLimit: 60_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    const expected = { from: signer.address, token: getAddress(TOKEN), to: getAddress(DEST), amount, chainId: 1 };
    expect(assertSignedErc20Transfer(raw, expected).data).toBe(data.toLowerCase());
    const withValue = await signer.signTransaction({
      type: 2,
      chainId: 1,
      to: TOKEN,
      value: 1n,
      data,
      nonce: 0,
      gasLimit: 60_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    expect(() => assertSignedErc20Transfer(withValue, expected)).toThrow(/non-zero native value/);
  });
});

describe("lookup gate", () => {
  it("requires the test token and the allowlist before any RPC", async () => {
    delete process.env.TEST_SEND_TOKEN;
    await expect(runTestLookup("x", { walletId: "tloqxjloa5jloj6dv38n0fmf" })).rejects.toMatchObject({ code: "TEST_SEND_DISABLED" });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.PRIVY_SIWE_KEY_QUORUM_ID = "siwe-quorum";
    process.env.TEST_SEND_TOKEN = "desk-token-value";
    delete process.env.TEST_SEND_WALLET_IDS;
    await expect(runTestLookup("desk-token-value", { walletId: "not-allowlisted" })).rejects.toMatchObject({
      code: "WALLET_NOT_ALLOWLISTED",
    });
    await expect(
      runTestErc20Send("nope", { walletId: "tloqxjloa5jloj6dv38n0fmf", chainId: 1, token: TOKEN, amount: "1", destination: DEST }),
    ).rejects.toMatchObject({ code: "TEST_SEND_UNAUTHORIZED" });
  });
});
