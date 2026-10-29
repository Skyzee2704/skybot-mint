// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { createPlan, consumePlan } from "../src/core/plans.js";

describe("per-user plans", () => {
  it("isolates plans by userId", () => {
    const a = createPlan("user-a", "mint", { n: 1 }, "MINT 1");
    const b = createPlan("user-b", "mint", { n: 2 }, "MINT 2");
    expect(() => consumePlan("user-b", a.id, "mint", "MINT 1")).toThrow(/another user/);
    expect(consumePlan("user-a", a.id, "mint", "MINT 1").data).toEqual({ n: 1 });
    expect(consumePlan("user-b", b.id, "mint", "MINT 2").data).toEqual({ n: 2 });
  });
});

describe("telegram link code format", () => {
  it("deep link uses link_ prefix", () => {
    const bot = "SkymintsBOT";
    const code = "abc123";
    const deep = `https://t.me/${bot}?start=link_${code}`;
    expect(deep).toMatch(/start=link_/);
    const payload = deep.split("start=")[1];
    expect(payload.startsWith("link_")).toBe(true);
    expect(payload.slice(5)).toBe(code);
  });
});

describe("mint checkbox confirmation", () => {
  it("requires confirmed:true and the plan's mint count", async () => {
    const { createPlan, consumePlan, mintConfirmation } = await import("../src/core/plans.js");
    expect(() => mintConfirmation({})).toThrow(/Tick the confirmation/);
    expect(() => mintConfirmation({ confirmed: false as any, nfts: 2 })).toThrow(/Tick/);
    expect(() => mintConfirmation({ confirmed: true })).toThrow(/Tick/);
    const p = createPlan("u", "mint", { n: 2 }, "MINT 2");
    expect(() => consumePlan("u", p.id, "mint", mintConfirmation({ confirmed: true, nfts: 3 }))).toThrow(/doesn't match/);
    expect(consumePlan("u", p.id, "mint", mintConfirmation({ confirmed: true, nfts: 2 })).data).toEqual({ n: 2 });
    expect(mintConfirmation({ confirmPhrase: "MINT 4" })).toBe("MINT 4");
  });
});
