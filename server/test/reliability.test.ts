// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcProvider } from "ethers";
import { feesMoved } from "../src/core/mint/fees.js";
import { isStageNotLive, sendWhenLive, SIM_INTERVAL_MS, SIM_LEAD_MS, startStageProbe } from "../src/core/mint/readiness.js";
import { RpcPool } from "../src/core/rpc/pool.js";
import { getChain } from "../src/config/chains.js";
import {
  acquireOpenseaKey,
  keyIndexForWallet,
  listOpenseaApiKeys,
  openseaKeyLog,
  penalizeOpenseaKey,
  resetOpenseaKeyPool,
  testOpenseaKeys,
} from "../src/core/resolver/openseaKeys.js";
import { ethersRoutedThroughFetch, installKeepAlive } from "../src/util/keepalive.js";

const SECRET_A = "test-key-alpha-do-not-log";
const SECRET_B = "test-key-beta-do-not-log";

describe("OpenSea key pool", () => {
  afterEach(() => {
    delete process.env.OPENSEA_API_KEYS;
    delete process.env.OPENSEA_API_KEY;
    resetOpenseaKeyPool();
  });

  it("uses the comma-separated pool, and a single key when the pool is empty", () => {
    expect(listOpenseaApiKeys("", "only-one")).toEqual(["only-one"]);
    expect(listOpenseaApiKeys(" a, b ,a ", "ignored")).toEqual(["a", "b", "a"]);
    expect(keyIndexForWallet(0, 2)).toBe(0);
    expect(keyIndexForWallet(1, 2)).toBe(1);
    expect(keyIndexForWallet(2, 2)).toBe(0);
  });

  it("skips a cooling key and uses the next one immediately", async () => {
    process.env.OPENSEA_API_KEYS = `${SECRET_A},${SECRET_B}`;
    resetOpenseaKeyPool();
    penalizeOpenseaKey(0, Date.now() + 5_000);
    const started = Date.now();
    const held = await acquireOpenseaKey(0);
    expect(held?.index).toBe(1);
    expect(Date.now() - started).toBeLessThan(80);
    held?.release();
    const line = openseaKeyLog();
    expect(line).toContain("key0");
    expect(line).toContain("key1");
    expect(line).not.toContain(SECRET_A);
    expect(line).not.toContain(SECRET_B);
  });

  it("rotates to the next key on 429 without waiting for Retry-After", async () => {
    process.env.OPENSEA_API_KEYS = `${SECRET_A},${SECRET_B}`;
    resetOpenseaKeyPool();
    const seen: string[] = [];
    const started = Date.now();
    const { openseaFetch } = await import("../src/core/resolver/openseaKeys.js");
    const res = await openseaFetch({
      priority: "mint",
      url: "https://api.opensea.io/api/v2/drops/demo/mint",
      method: "POST",
      fetchImpl: async (_url, init) => {
        const key = new Headers(init?.headers).get("x-api-key") ?? "";
        seen.push(key);
        if (key === SECRET_A) return new Response("no", { status: 429, headers: { "retry-after": "30" } });
        return new Response("{}", { status: 200, headers: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "40" } });
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([SECRET_A, SECRET_B]);
    expect(Date.now() - started).toBeLessThan(150);
    expect(openseaKeyLog()).not.toContain(SECRET_A);
  });

  it("reports latency and remaining per index and never the key", async () => {
    process.env.OPENSEA_API_KEYS = SECRET_A;
    resetOpenseaKeyPool();
    const rows = await testOpenseaKeys(async () => {
      return new Response("{}", {
        status: 200,
        headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "80", "x-ratelimit-reset": "30" },
      });
    });
    expect(rows).toEqual([expect.objectContaining({ index: 0, ok: true, limit: 100, remaining: 80 })]);
    expect(JSON.stringify(rows)).not.toContain(SECRET_A);
  });
});

describe("pre-signed readiness", () => {
  it("recognises a stage that is not live yet", () => {
    expect(SIM_LEAD_MS).toBe(1_000);
    expect(SIM_INTERVAL_MS).toBe(50);
    expect(isStageNotLive("execution reverted: Mint has not started")).toBe(true);
    expect(isStageNotLive("nonce too low")).toBe(false);
    expect(feesMoved(100n, 111n)).toBe(true);
    expect(feesMoved(100n, 109n)).toBe(false);
  });

  it("sends at once when the first broadcast is accepted", async () => {
    let sends = 0;
    let waited = false;
    const ready = {
      wait: async () => {
        waited = true;
        return true;
      },
    };
    const out = await sendWhenLive(async () => {
      sends++;
      return { ok: true, errors: [] as string[] };
    }, ready);
    expect(out.ok).toBe(true);
    expect(sends).toBe(1);
    expect(waited).toBe(false);
  });

  it("re-sends the same transaction once eth_call would pass", async () => {
    const fireAt = 5_000;
    let t = fireAt - SIM_LEAD_MS;
    let sends = 0;
    const probe = startStageProbe({
      fireAt,
      deadline: fireAt + 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      call: async () => {
        if (t < fireAt) throw new Error("Mint has not started");
      },
    });
    const out = await sendWhenLive(async () => {
      sends++;
      if (sends === 1) return { ok: false, errors: ["execution reverted: Mint has not started"] };
      return { ok: true, errors: [] as string[] };
    }, probe);
    expect(out.ok).toBe(true);
    expect(sends).toBe(2);
    expect(t).toBeGreaterThanOrEqual(fireAt);
  });
});

describe("RPC read order", () => {
  it("prefers the lower eth_chainId latency", () => {
    const base = getChain("base")!;
    const pool = new RpcPool(base, { read: ["https://slow.invalid", "https://fast.invalid"], send: [] });
    pool.endpoints[0]!.latencyMs = 400;
    pool.endpoints[1]!.latencyMs = 20;
    expect(pool.ordered().map((e) => e.url)).toEqual(["https://fast.invalid", "https://slow.invalid"]);
  });
});

describe("keep-alive coverage", () => {
  it("sends ethers JSON-RPC reads through global fetch", async () => {
    installKeepAlive();
    expect(ethersRoutedThroughFetch()).toBe(true);
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const provider = new JsonRpcProvider("https://rpc.test/v2/secret-key", 8453, { staticNetwork: true });
      const id = await provider.send("eth_chainId", []);
      expect(id).toBe("0x2105");
      expect(seen.some((url) => url.includes("rpc.test"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
