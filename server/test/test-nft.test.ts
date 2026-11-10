// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { Interface, Wallet, getAddress } from "ethers";
import {
  ERC1155_SAFE_SELECTOR,
  ERC721_SAFE_SELECTOR,
  assertSignedNftTransfer,
  encodeNftTransfer,
  parseUint,
  runTestNftSend,
} from "../src/testsend/nft.js";

const FROM = getAddress("0xb22b000000000000000000000000000000004d2f");
const TO = getAddress("0xdd911fa75e72b3c11e75dcabfae9f60d65903877");
const CONTRACT = getAddress("0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");

const prev = process.env.TEST_SEND_TOKEN;
afterEach(() => {
  if (prev === undefined) delete process.env.TEST_SEND_TOKEN;
  else process.env.TEST_SEND_TOKEN = prev;
});

describe("nft calldata", () => {
  it("encodes ERC-721 and ERC-1155 safeTransferFrom", () => {
    const id = parseUint("42", "Token id");
    const erc721 = encodeNftTransfer("erc721", FROM, TO, id);
    expect(erc721.toLowerCase().startsWith(ERC721_SAFE_SELECTOR)).toBe(true);
    const decoded721 = new Interface(["function safeTransferFrom(address,address,uint256)"]).decodeFunctionData("safeTransferFrom", erc721);
    expect(getAddress(decoded721[0])).toBe(getAddress(FROM));
    expect(getAddress(decoded721[1])).toBe(getAddress(TO));
    expect(decoded721[2]).toBe(42n);

    const erc1155 = encodeNftTransfer("erc1155", FROM, TO, id, 3n);
    expect(erc1155.toLowerCase().startsWith(ERC1155_SAFE_SELECTOR)).toBe(true);
    const decoded1155 = new Interface(["function safeTransferFrom(address,address,uint256,uint256,bytes)"]).decodeFunctionData(
      "safeTransferFrom",
      erc1155,
    );
    expect(decoded1155[3]).toBe(3n);
    expect(decoded1155[4]).toBe("0x");
    expect(() => parseUint("0", "Amount", { positive: true })).toThrow(/greater than 0/);
    expect(() => encodeNftTransfer("erc1155", FROM, TO, id)).toThrow(/greater than 0/);
  });

  it("accepts a value-0 signed transfer and rejects native value", async () => {
    const signer = Wallet.createRandom();
    const data = encodeNftTransfer("erc721", signer.address, TO, 7n);
    const raw = await signer.signTransaction({
      type: 2,
      chainId: 1,
      to: CONTRACT,
      value: 0n,
      data,
      nonce: 0,
      gasLimit: 80_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    const expected = {
      from: signer.address,
      contract: getAddress(CONTRACT),
      to: getAddress(TO),
      tokenId: 7n,
      amount: null,
      chainId: 1,
      standard: "erc721" as const,
    };
    expect(assertSignedNftTransfer(raw, expected).data).toBe(data.toLowerCase());
    const paid = await signer.signTransaction({
      type: 2,
      chainId: 1,
      to: CONTRACT,
      value: 1n,
      data,
      nonce: 0,
      gasLimit: 80_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    expect(() => assertSignedNftTransfer(paid, expected)).toThrow(/non-zero native value/);
  });
});

describe("nft send gate", () => {
  it("requires the test token before any RPC", async () => {
    delete process.env.TEST_SEND_TOKEN;
    await expect(
      runTestNftSend("x", { walletId: "tloqxjloa5jloj6dv38n0fmf", chainId: 1, contract: CONTRACT, tokenId: "1", destination: TO }),
    ).rejects.toMatchObject({ code: "TEST_SEND_DISABLED" });
  });
});
