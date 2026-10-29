// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { paginate, parseJobsCallback, renderJobsPage, resultSummary } from "../src/bot/jobsList.js";

const job = (i: number, status: string, extra: any = {}) =>
  ({
    id: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
    userId: "u",
    createdAt: "2026-10-29T14:00:00.000Z",
    status,
    runAt: "2026-10-29T14:00:00.000Z",
    startedAt: null,
    broadcastAt: null,
    chain: "base",
    target: "0x" + "a".repeat(40),
    strategy: "opensea_api",
    request: { slug: i === 1 ? "<cubs>" : "ethernal-cubs", wallets: [{}, {}] },
    results: [],
    log: [],
    ...extra,
  }) as any;

describe("jobs list helpers", () => {
  it("paginates 5 per page and clamps the page", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(paginate(items, 0)).toMatchObject({ page: 0, pages: 3, items: [0, 1, 2, 3, 4] });
    expect(paginate(items, 2).items).toEqual([10, 11]);
    expect(paginate(items, 99).page).toBe(2);
    expect(paginate([], 3)).toMatchObject({ page: 0, pages: 1, total: 0 });
  });

  it("parses callback data", () => {
    expect(parseJobsCallback("jl:a:2")).toEqual({ tab: "a", page: 2 });
    expect(parseJobsCallback("jl:h:0")).toEqual({ tab: "h", page: 0 });
    expect(parseJobsCallback("jl:m")).toBe("menu");
    expect(parseJobsCallback("jl:x:1")).toBeNull();
  });

  it("summarises results with token ids", () => {
    const j = job(1, "done", {
      results: [{ status: "confirmed", tokenIds: ["25"] }, { status: "failed" }],
    });
    expect(resultSummary(j)).toBe("1/2 minted · #25");
    expect(resultSummary(job(2, "failed", { error: "boom" }))).toBe("boom");
  });

  it("renders active/history pages with nav, cancel, back and escaping", () => {
    const all = [...Array.from({ length: 7 }, (_, i) => job(i + 1, "scheduled")), job(20, "done")];
    const r = renderJobsPage(all, "a", 0, { timeZone: "Asia/Makassar", now: 0, cancellable: () => true });
    expect(r.text).toContain("Active jobs</b> · 1/2");
    expect(r.text).toContain("&lt;cubs&gt;");
    expect(r.text).toContain("2 wallets");
    expect(r.text).not.toContain("Times in UTC");
    const kb = r.keyboard.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(kb.filter((d: string) => d.startsWith("jc:")).length).toBe(5);
    expect(kb).toContain("jl:a:1");
    expect(kb).toContain("jl:m");
    const p2 = renderJobsPage(all, "a", 1, { timeZone: null, now: 0 });
    expect(p2.text).toContain("2/2");
    expect(p2.keyboard.inline_keyboard.flat().map((b: any) => b.callback_data)).toContain("jl:a:0");
    expect(p2.text).toContain("Times in UTC");
    const h = renderJobsPage(all, "h", 0, { timeZone: null });
    expect(h.text).toContain("✅ Done");
    expect(h.keyboard.inline_keyboard.flat().some((b: any) => b.callback_data?.startsWith("jl:h:"))).toBe(false);
    expect(renderJobsPage([], "h", 0, { timeZone: null }).text).toContain("No finished mints yet.");
  });
});
