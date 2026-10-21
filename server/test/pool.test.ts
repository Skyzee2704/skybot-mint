// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { RpcPool, isRetryable } from "../src/core/rpc/pool.js";
import { getChain } from "../src/config/chains.js";

const base = getChain("base")!;
describe("RpcPool", () => {
  it("rotates on transport errors and verifies chain id", async () => {
    const pool = new RpcPool(
      base,
      { read: ["https://a.invalid", "https://b.invalid"], send: ["https://a.invalid", "https://b.invalid"] },
      { timeoutMs: 500, baseBackoffMs: 1 },
    );
    pool.endpoints.forEach((e) => (e.verified = true));
    let calls = 0;
    const out = await pool.read(async (p) => {
      calls++;
      if ((p as any)._getConnection().url.includes("a.invalid"))
        throw Object.assign(new Error("429 Too Many Requests"), { code: "SERVER_ERROR" });
      return 42;
    });
    expect(out).toBe(42);
    expect(calls).toBe(2);
    expect(pool.endpoints[0].cooldownUntil).toBeGreaterThan(Date.now());
    // next read should prefer the healthy endpoint first
    expect(pool.ordered()[0].url).toBe("https://b.invalid");
  });
  it("does not retry reverts", async () => {
    const pool = new RpcPool(base, { read: ["https://a.invalid", "https://b.invalid"], send: [] }, { timeoutMs: 500, baseBackoffMs: 1 });
    pool.endpoints.forEach((e) => (e.verified = true));
    let calls = 0;
    await expect(
      pool.read(async () => {
        calls++;
        throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
      }),
    ).rejects.toThrow(/reverted/);
    expect(calls).toBe(1);
  });
  it("classifies errors", () => {
    expect(isRetryable({ code: "CALL_EXCEPTION", message: "execution reverted" })).toBe(false);
    expect(isRetryable({ code: "CALL_EXCEPTION", message: "rate limit exceeded" })).toBe(true);
    expect(isRetryable({ code: "TIMEOUT" })).toBe(true);
  });
  it("broadcasts to all endpoints incl send-only, counts 'already known' as accepted", async () => {
    const seen: string[] = [];
    const pool = new RpcPool(
      base,
      { read: ["https://a.invalid"], send: ["https://a.invalid", "https://seq.invalid", "https://bad.invalid"] },
      {
        fetchImpl: async (url) => {
          seen.push(url);
          return {
            json: async () =>
              url.includes("a.")
                ? { result: "0x1" }
                : url.includes("seq")
                  ? { error: { message: "already known" } }
                  : { error: { message: "nonce too low" } },
          };
        },
      },
    );
    const r = await pool.broadcast("0x02f8");
    expect(seen.sort()).toEqual(["https://a.invalid", "https://bad.invalid", "https://seq.invalid"]);
    expect(r.accepted.length).toBe(2);
    expect(r.errors[0].error).toMatch(/nonce too low/);
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
