import { describe, expect, it } from "vitest";
import { AbiCoder, keccak256 } from "ethers";
import { SEADROP_ERRORS, classifyRevert, decodeRevert, merkleAccess, merkleRoot, parseAllowList, seadropLeaf } from "../src/core/mint/access.js";
import { buildSiweMessage, sessionCookies, SIWE_STATEMENT } from "../src/core/resolver/openseaAuth.js";
import { esc } from "../src/bot/telegram.js";
import { redactString } from "../src/util/log.js";

const A = "0x4B92b75EFB0F5eBA9AB819C8775d56fbDc89ECcA", B = "0x5D1f449A593DB76f9ce007A311d62830CAE7Bd1b", C = "0x000000000000000000000000000000000000dEaD";
const mp = { mintPrice: "1000", maxTotalMintableByWallet: 2, startTime: 1, endTime: 2, dropStageIndex: 1, maxTokenSupplyForStage: 100, feeBps: 1000, restrictFeeRecipients: true };

describe("revert decoding", () => {
  it("decodes SeaDrop custom errors", () => {
    expect(decodeRevert(SEADROP_ERRORS.encodeErrorResult("InvalidProof", []))).toBe("InvalidProof()");
    expect(decodeRevert(SEADROP_ERRORS.encodeErrorResult("NotActive", [10, 1792000000, 1793000000]))).toMatch(/^NotActive \(stage starts 2026/);
    expect(decodeRevert(SEADROP_ERRORS.encodeErrorResult("MintQuantityExceedsMaxMintedPerWallet", [3, 2]))).toBe("MintQuantityExceedsMaxMintedPerWallet(3, 2)");
  });
  it("decodes Error(string)", () => expect(decodeRevert("0x08c379a0" + AbiCoder.defaultAbiCoder().encode(["string"], ["Sale not active"]).slice(2))).toBe("Sale not active"));
  it("classifies access-denied reverts", () => {
    expect(classifyRevert("InvalidProof()")).toBe("no");
    expect(classifyRevert("InvalidSignature(0x00)")).toBe("no");
    expect(classifyRevert("NotActive (…)")).toBe("unknown");
  });
});

describe("merkle allowlist", () => {
  it("builds a sorted-pair root that verifies a proof", () => {
    const leaves = [A, B, C].map((a) => seadropLeaf(a, mp));
    const root = merkleRoot(leaves);
    const h = (x: string, y: string) => keccak256(x.toLowerCase() < y.toLowerCase() ? x + y.slice(2) : y + x.slice(2));
    expect(root).toBe(h(h(leaves[0], leaves[1]), leaves[2]));
  });
  it("parses plaintext lists and refuses PGP", () => {
    expect(parseAllowList("-----BEGIN PGP MESSAGE-----\nabc")).toBeNull();
    expect(parseAllowList(JSON.stringify([A, B]))!.map((e) => e.address)).toEqual([A, B]);
    expect(parseAllowList(JSON.stringify([{ address: A, ...mp }]))![0].mintParams.mintPrice).toBe("1000");
    expect(parseAllowList(`address\n${A}\n${B}`)!.length).toBe(2);
  });
  it("membership verdicts", () => {
    const members = new Map([[A.toLowerCase(), { address: A }]]);
    const info: any = { root: "0x1", uri: "ipfs://x", state: "plaintext", members, rootVerified: true };
    expect(merkleAccess(info, A)!.status).toBe("yes");
    expect(merkleAccess(info, B)!.status).toBe("no");
    expect(merkleAccess({ ...info, state: "encrypted", members: undefined }, A)!.status).toBe("unknown");
    expect(merkleAccess({ ...info, rootVerified: false }, A)!.status).toBe("unknown");
  });
});

describe("OpenSea SIWE helpers", () => {
  it("builds the exact message layout OpenSea rebuilds server-side", () => {
    const m = buildSiweMessage(A.toLowerCase(), "abcdef123456", new Date("2026-10-21T10:00:00.000Z"));
    expect(m.text).toBe(`opensea.io wants you to sign in with your Ethereum account:\n${A}\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io\nVersion: 1\nChain ID: 1\nNonce: abcdef123456\nIssued At: 2026-10-21T10:00:00.000Z`);
    expect(m.fields).toMatchObject({ domain: "opensea.io", address: A, chainId: "1", accountType: "Ethereum" });
  });
  it("extracts session cookies", () => {
    const h = new Headers(); h.append("set-cookie", "access_token=aaa; Path=/; HttpOnly"); h.append("set-cookie", "refresh_token=bbb; Path=/");
    expect(sessionCookies(h)).toBe("access_token=aaa; refresh_token=bbb");
    expect(() => sessionCookies(new Headers())).toThrow(/cookie/);
  });
});

describe("telegram + redaction", () => {
  it("escapes HTML", () => expect(esc("<b>A&B</b>")).toBe("&lt;b&gt;A&amp;B&lt;/b&gt;"));
  it("redacts bot tokens", () => expect(redactString("err 1234567890:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll x")).toBe("err [REDACTED_BOT_TOKEN] x"));
});
