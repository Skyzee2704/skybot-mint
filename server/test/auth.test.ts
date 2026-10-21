import { describe, expect, it, beforeEach } from "vitest";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
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
    const bot = "MyTradeSkyBOT"; const code = "abc123";
    const deep = `https://t.me/${bot}?start=link_${code}`;
    expect(deep).toMatch(/start=link_/);
    const payload = deep.split("start=")[1];
    expect(payload.startsWith("link_")).toBe(true);
    expect(payload.slice(5)).toBe(code);
  });
});
