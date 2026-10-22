// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { AbiCoder, Interface, id, parseEther } from "ethers";
import {
  decodeRevertData,
  describeTxError,
  explainRevert,
  gasShortfallMessage,
  revertDataOf,
} from "../src/core/tx/revert.js";
import { planWalletGas } from "../src/core/nft/transfer.js";

const enc = (sig: string, types: string[] = [], vals: unknown[] = []) =>
  id(sig).slice(0, 10) + AbiCoder.defaultAbiCoder().encode(types, vals).slice(2);

describe("revert decoding", () => {
  it("explains the real Robinhood failures (raw revert data from production)", () => {
    // Drip Dragons #1622 / ZOMBOX #569 from an EIP-7702-delegated wallet (Limit Break transfer validator).
    const a = decodeRevertData("0x369c2f4c");
    expect(a.name).toBe("CreatorTokenTransferValidator__OTCNotAllowedFor7702Delegates");
    expect(a.message).toMatch(/EIP-7702/);
    // Friend #301531.
    const b = decodeRevertData("0x39646e1a");
    expect(b.name).toBe("TemporaryFriendLocked");
    expect(b.message).toMatch(/temporarily locked/);
  });

  it("decodes Error(string), Panic and OpenZeppelin / ERC721A errors into plain English", () => {
    expect(decodeRevertData(enc("Error(string)", ["string"], ["Pausable: paused"])).message).toMatch(/paused/);
    expect(decodeRevertData(enc("Panic(uint256)", ["uint256"], [0x11])).message).toMatch(/overflow/);
    const ap = decodeRevertData(enc("ERC721InsufficientApproval(address,uint256)", ["address", "uint256"], ["0x" + "11".repeat(20), 7]));
    expect(ap.name).toBe("ERC721InsufficientApproval");
    expect(ap.message).toMatch(/approval/);
    expect(decodeRevertData(enc("TransferFromIncorrectOwner()")).message).toMatch(/no longer owns/);
    expect(decodeRevertData(enc("OperatorNotAllowed(address)", ["address"], ["0x" + "22".repeat(20)])).message).toMatch(/transfer rules/);
    expect(decodeRevertData("0x").message).toMatch(/without giving a reason/);
  });

  it("keeps the raw selector for unknown errors and falls back to the signature DB (keccak-checked)", async () => {
    const data = enc("VaultSealed(uint256)", ["uint256"], [3]);
    expect(decodeRevertData(data)).toMatchObject({ via: "none", selector: data.slice(0, 10) });
    expect(decodeRevertData(data).message).toContain(data.slice(0, 10));
    const sel = data.slice(0, 10);
    const fake = (async () =>
      Response.json({ result: { function: { [sel]: [{ name: "Wrong(uint8)" }, { name: "VaultSealed(uint256)" }] } } })) as unknown as typeof fetch;
    const d = await explainRevert(data, { fetchImpl: fake });
    expect(d).toMatchObject({ via: "signature-db", name: "VaultSealed", args: ["3"] });
  });

  it("uses the contract's verified ABI when provided", () => {
    const abi = new Interface(["error SaleClosed(uint256 at)"]);
    const d = decodeRevertData(abi.encodeErrorResult("SaleClosed", [5]), abi);
    expect(d).toMatchObject({ via: "abi", name: "SaleClosed", args: ["5"] });
  });

  it("finds revert data nested anywhere in provider errors", async () => {
    const e = { code: "RPC_EXHAUSTED", cause: { info: { error: { data: "0x369c2f4c" } } } };
    expect(revertDataOf(e)).toBe("0x369c2f4c");
    expect(revertDataOf({ body: JSON.stringify({ error: { data: "0x39646e1a" } }) })).toBe("0x39646e1a");
    expect((await describeTxError(e)).message).toMatch(/EIP-7702/);
    expect((await describeTxError({ code: "INSUFFICIENT_FUNDS", message: "insufficient funds" })).message).toMatch(/Not enough/);
  });

  it("reports gas shortfalls with exact amounts", () => {
    expect(gasShortfallMessage(parseEther("0.0012"), parseEther("0.0003"), "ETH")).toBe(
      "Not enough ETH for gas: need 0.0012 ETH, have 0.0003 ETH.",
    );
    const p = planWalletGas(100n, 1n, [{ key: "a", gasLimit: 150n, l1Fee: 0n }], "ETH");
    expect(p.items[0].skip).toMatch(/^Not enough ETH for gas: need/);
  });
});
