// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { OpenSeaClient } from "../src/core/resolver/opensea.js";
import {
  BUILD_CONCURRENCY,
  FIRST_WAVE_OFFSET_MS,
  OPENSEA_LEAD_MS,
  PROBE_BACKOFF_CAP_MS,
  probeAndRelease,
  probeRetryDelay,
  parseRetryAfterMs,
  rateLimitWaitMs,
  type ProbeCall,
} from "../src/core/mint/openseaLimit.js";
import { KEEP_ALIVE_CONNECTIONS } from "../src/util/keepalive.js";

function clock(start: number) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("OpenSea probe and release", () => {
  it("locks the wave at T0 and a concurrency that fits the keep-alive pool", () => {
    expect(FIRST_WAVE_OFFSET_MS).toBe(0);
    expect(BUILD_CONCURRENCY).toBe(100);
    expect(BUILD_CONCURRENCY).toBeLessThanOrEqual(KEEP_ALIVE_CONNECTIONS);
    expect(PROBE_BACKOFF_CAP_MS).toBe(500);
    expect(probeRetryDelay(0, 0, 0)).toBe(75);
    expect(probeRetryDelay(1_501, 0, 0)).toBe(150);
    expect(probeRetryDelay(1_501, 0, 1)).toBe(300);
    expect(probeRetryDelay(1_501, 0, 2)).toBe(500);
  });

  it("opening exactly at T0 is one wave plus two probe lead-ins, and nobody waits", async () => {
    const fireAt = 10_000;
    const c = clock(fireAt - OPENSEA_LEAD_MS);
    const calls: number[][] = Array.from({ length: 100 }, () => []);
    const report = await probeAndRelease<number>({
      count: 100,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async (i) => {
        calls[i]!.push(c.now());
        if (c.now() < fireAt) return { kind: "closed" };
        return { kind: "ok", value: i, limit: 400, remaining: 300 };
      },
    });
    expect(report.httpCalls).toBe(102);
    expect(report.released).toBe(0);
    expect(report.results.every((r) => r.state === "ok")).toBe(true);
    expect(calls[0]).toEqual([fireAt - 150, fireAt - 75, fireAt]);
    for (let i = 1; i < 100; i++) expect(calls[i]).toEqual([fireAt]);
    expect(report.maxInFlight).toBe(100);
  });

  it("opening at T0+400ms is two wallet passes plus the probe polls, not a 409 storm", async () => {
    const fireAt = 10_000;
    const openAt = fireAt + 400;
    const c = clock(fireAt - OPENSEA_LEAD_MS);
    const calls: number[][] = Array.from({ length: 100 }, () => []);
    const report = await probeAndRelease<number>({
      count: 100,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async (i) => {
        calls[i]!.push(c.now());
        if (c.now() < openAt) return { kind: "closed" };
        return { kind: "ok", value: i };
      },
    });
    // 100 at T0, 99 released, 2 probe calls before T0, and 6 probe calls after the T0 wave.
    expect(report.httpCalls).toBe(207);
    expect(report.httpCalls).toBeLessThan(250);
    expect(report.released).toBe(99);
    expect(report.results.every((r) => r.state === "ok")).toBe(true);
    expect(calls[0]!.length).toBeGreaterThan(2);
    for (let i = 1; i < 100; i++) expect(calls[i]).toHaveLength(2);
    expect(calls[1]![0]).toBe(fireAt);
    expect(calls[1]![1]).toBeGreaterThanOrEqual(openAt);
  });

  it("a 429 pauses every wallet and retries it instead of failing", async () => {
    const fireAt = 5_000;
    const c = clock(fireAt);
    const starts: number[] = [];
    let n = 0;
    const report = await probeAndRelease<number>({
      count: 8,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async (i) => {
        starts.push(c.now());
        n++;
        if (n === 1) return { kind: "rate", retryAfterMs: 1_000, limit: 100, remaining: 80 };
        return { kind: "ok", value: i, limit: 100, remaining: 80 };
      },
    });
    expect(report.results.every((r) => r.state === "ok")).toBe(true);
    expect(report.rateLimits).toBe(1);
    expect(report.minConcurrency).toBe(BUILD_CONCURRENCY / 2);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(fireAt + 1_000);
  });

  it("honors a long Retry-After up to the deadline and keeps the header value", () => {
    const now = 1_000_000;
    expect(parseRetryAfterMs("12", now)).toBe(12_000);
    expect(rateLimitWaitMs(now, now + 30_000, { retryAfterMs: 8_000 })).toBe(8_000);
    expect(rateLimitWaitMs(now, now + 5_000, { retryAfterMs: 8_000 })).toBe(5_000);
    expect(rateLimitWaitMs(now, now + 30_000, { resetAt: now + 12_000 })).toBe(12_000);
  });

  it("preserves a Retry-After above 5s on the mint error", async () => {
    const os = new OpenSeaClient("test-key", async () => new Response("slow", { status: 429, headers: { "retry-after": "12" } }));
    const err = await os.buildMint("slug", "0x" + "ab".repeat(20), 1, 1_500).then(
      () => null,
      (e: ProbeCall<unknown> & { retryAfterMs?: number }) => e,
    );
    expect(err?.retryAfterMs).toBe(12_000);
  });

  it("a transient timeout on the only wallet retries until it succeeds instead of failing the job", async () => {
    // Regression: a 1-wallet FCFS job used to fail with "OpenSea mint timed out" after two
    // timeouts (~3 s) even though the build budget was still open — the probe gave up and the
    // first wave marked the timeout as terminal. Now it retries until the deadline.
    const fireAt = 10_000;
    const c = clock(fireAt - OPENSEA_LEAD_MS);
    let attempts = 0;
    const report = await probeAndRelease<number>({
      count: 1,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async () => {
        attempts++;
        await c.sleep(1_500); // the mint API call hangs until its timeout
        if (attempts <= 2) return { kind: "promote", error: new Error("OpenSea mint timed out") };
        return { kind: "ok", value: 0 };
      },
    });
    expect(attempts).toBe(3);
    expect(report.results[0]?.state).toBe("ok");
  });

  it("a wallet that keeps timing out fails at the build deadline instead of hanging", async () => {
    const fireAt = 10_000;
    const c = clock(fireAt - OPENSEA_LEAD_MS);
    let attempts = 0;
    const report = await probeAndRelease<number>({
      count: 1,
      fireAt,
      deadline: fireAt + 30_000,
      now: c.now,
      sleep: c.sleep,
      call: async () => {
        attempts++;
        await c.sleep(1_500);
        return { kind: "promote", error: new Error("OpenSea mint timed out") };
      },
    });
    expect(attempts).toBeGreaterThan(2);
    expect(report.results[0]?.state).toBe("error");
    expect(c.now()).toBeLessThanOrEqual(fireAt + 30_000 + 1_500);
  });
});
