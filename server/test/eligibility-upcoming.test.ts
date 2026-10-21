// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { buildSiweMessage, eligibilityWithJwt, jwtFromSignature, validateSiweFields } from "../src/core/resolver/openseaAuth.js";
import { decide } from "../src/core/mint/eligibility.js";

describe("OpenSea sign-in (browser-signed) for upcoming-stage eligibility", () => {
  const w = Wallet.createRandom();

  it("accepts only the exact OpenSea login layout for the user's own wallet", () => {
    const { fields } = buildSiweMessage(w.address, "abcdefgh12345678");
    expect(() => validateSiweFields(fields, w.address)).not.toThrow();
    expect(() => validateSiweFields({ ...fields, domain: "evil.example" }, w.address)).toThrow(/Invalid/);
    expect(() => validateSiweFields({ ...fields, statement: "Transfer everything" }, w.address)).toThrow(/Invalid/);
    expect(() => validateSiweFields(fields, Wallet.createRandom().address)).toThrow(/different wallet/);
    const old = buildSiweMessage(w.address, "abcdefgh12345678", new Date(Date.now() - 3600_000)).fields;
    expect(() => validateSiweFields(old, w.address)).toThrow(/Invalid/);
  });

  it("exchanges a signature for a read:eligibility JWT, revokes the PAT and caches the JWT", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.opensea.io", "")}`);
      if (url.endsWith("/siwe/verify"))
        return new Response("{}", { status: 200, headers: { "set-cookie": "access_token=abc; Path=/; HttpOnly" } });
      if (url.endsWith("/auth/tokens") && init.method === "POST") {
        expect(JSON.parse(init.body).scopes).toEqual(["read:eligibility"]);
        return Response.json({ id: "pat1", token: "pat-secret" });
      }
      if (url.endsWith("/tokens/exchange")) return Response.json({ accessToken: "jwt-1", expiresIn: 3600 });
      if (url.includes("/auth/tokens/pat1")) return new Response(null, { status: 204 });
      throw new Error("unexpected " + url);
    }) as typeof fetch;
    const msg = buildSiweMessage(w.address, "abcdefgh12345678");
    const sig = await w.signMessage(msg.text);
    expect(await jwtFromSignature(msg.fields, sig, fake)).toBe("jwt-1");
    expect(calls).toContain("DELETE /api/v2/auth/tokens/pat1");
    const n = calls.length;
    expect(await jwtFromSignature(msg.fields, sig, fake)).toBe("jwt-1"); // cached
    expect(calls.length).toBe(n);
  });

  it("reads per-stage verdicts (upcoming stage included)", async () => {
    process.env.OPENSEA_API_KEY = "test-key";
    const fake = (async (_u: string, init: any) => {
      expect(init.headers.authorization).toBe("Bearer jwt-1");
      return Response.json({
        stages: [
          { stage_uuid: "presale", is_eligible: false, price: null, max_total_mintable_by_wallet: null },
          { stage_uuid: "public", is_eligible: true, price: "1500000000000000", max_total_mintable_by_wallet: "191" },
        ],
      });
    }) as typeof fetch;
    const r = await eligibilityWithJwt("jwt-1", "some-drop", fake);
    expect(r.find((s) => s.stage_uuid === "presale")?.is_eligible).toBe(false);
    expect(r.find((s) => s.stage_uuid === "public")?.max_total_mintable_by_wallet).toBe("191");
  });

  it("balance never limits the suggested quantity (it is a readiness warning only)", () => {
    const d = decide({
      balance: 0n,
      priceWei: 10n ** 15n,
      gasCostWei: 10n ** 12n,
      desiredQty: 5,
      maxPerWallet: 5,
      minted: 0,
      supplyRemaining: 100n,
      stageEnded: false,
    });
    expect(d.suggestedQty).toBe(5);
    expect(d.reasons.filter((r) => !r.startsWith("insufficient balance"))).toEqual([]);
  });
});
