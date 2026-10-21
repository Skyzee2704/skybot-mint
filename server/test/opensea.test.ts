import { describe, expect, it } from "vitest";
import { osErrorCode } from "../src/core/mint/build.js";
import { osStage, stagePriceWei } from "../src/core/mint/eligibility.js";

describe("OpenSea mint API error mapping", () => {
  it("maps 409 to NOT_ACTIVE", () => expect(osErrorCode(409, "Drop is not active")).toBe("NOT_ACTIVE"));
  it("maps unfunded 422 to INSUFFICIENT_FUNDS, not an allowlist failure", () => expect(osErrorCode(422, "Insufficient balance to mint")).toBe("INSUFFICIENT_FUNDS"));
  it("maps other 422 to NOT_ELIGIBLE", () => expect(osErrorCode(422, "the wallet is not on this stage's allowlist")).toBe("NOT_ELIGIBLE"));
  it("keeps other statuses", () => expect(osErrorCode(500)).toBe("HTTP_500"));
});

describe("osStage", () => {
  const base: any = { stages: [{ type: "public", source: "onchain", status: "active", priceWei: "1", maxPerWallet: 9 }], seadrop: null, generic: null };
  it("prefers the drop's active stage (public stage is hidden from stages when on-chain exists)", () => {
    const t = { ...base, opensea: { drop: { active_stage: { price: "30000000000000000", max_per_wallet: "5" } } } };
    expect(osStage(t)).toEqual({ priceWei: "30000000000000000", maxPerWallet: 5 });
    expect(stagePriceWei(t, "opensea_api")).toBe(30000000000000000n);
  });
  it("falls back to next_stage, then resolved stages", () => {
    expect(osStage({ ...base, opensea: { drop: { active_stage: null, next_stage: { price: "7", max_per_wallet: "2" } } } })).toEqual({ priceWei: "7", maxPerWallet: 2 });
    expect(osStage({ ...base, opensea: { drop: null } })).toEqual({ priceWei: "1", maxPerWallet: 9 });
  });
});
