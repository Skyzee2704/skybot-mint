// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildSiweMessage } from "../src/core/resolver/openseaAuth.js";
import { assertFieldsMatch, assertOpenSeaSiwe } from "../src/core/resolver/siweGuard.js";

const A = "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0";
const B = "0x1111111111111111111111111111111111111111";

describe("OpenSea SIWE guard (auto-sign safety)", () => {
  it("accepts exactly OpenSea's fresh login text for the same wallet", () => {
    const m = buildSiweMessage(A, "abcDEF123456");
    const f = assertOpenSeaSiwe(m.text, A);
    expect(f.nonce).toBe("abcDEF123456");
    expect(() => assertFieldsMatch(m.text, m.fields, A)).not.toThrow();
  });
  it("refuses other wallets, stale messages, other domains, extra lines and non-strings", () => {
    const m = buildSiweMessage(A, "abcDEF123456");
    expect(() => assertOpenSeaSiwe(m.text, B)).toThrow(/different wallet/);
    expect(() => assertOpenSeaSiwe(buildSiweMessage(A, "abcDEF123456", new Date(Date.now() - 3600_000)).text, A)).toThrow(/fresh/);
    expect(() => assertOpenSeaSiwe(m.text.replace("opensea.io wants", "evil.io wants"), A)).toThrow();
    expect(() => assertOpenSeaSiwe(m.text.replace("URI: https://opensea.io", "URI: https://evil.io"), A)).toThrow();
    expect(() => assertOpenSeaSiwe(m.text + "\nResources:\n- https://evil.io", A)).toThrow();
    expect(() => assertOpenSeaSiwe(m.text.replace("Chain ID: 1", "Chain ID: 8453"), A)).toThrow();
    expect(() => assertOpenSeaSiwe({ types: {}, domain: {}, message: {} }, A)).toThrow();
    expect(() => assertOpenSeaSiwe("0x" + "ab".repeat(32), A)).toThrow();
  });
  it("refuses fields that disagree with the message", () => {
    const m = buildSiweMessage(A, "abcDEF123456");
    expect(() => assertFieldsMatch(m.text, { ...m.fields, nonce: "zzzzzzzzzz" }, A)).toThrow(/nonce/);
  });
});
