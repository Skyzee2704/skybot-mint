// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user/per-route rate limiting.
 * Upstash Redis (sliding window) when UPSTASH_REDIS_REST_URL/TOKEN are set — shared across Vercel instances.
 * Otherwise an in-memory fixed window (fine for local dev; per-instance only on serverless).
 */
import { env } from "../config/env.js";

type Limiter = { limit: (key: string) => Promise<{ success: boolean }> };
const upstash = new Map<number, Limiter>();
const mem = new Map<string, { count: number; window: number }>();

async function upstashLimiter(limit: number): Promise<Limiter | null> {
  if (!env.upstashRedisUrl || !env.upstashRedisToken) return null;
  if (!upstash.has(limit)) {
    const { Ratelimit } = await import("@upstash/ratelimit");
    const { Redis } = await import("@upstash/redis");
    upstash.set(
      limit,
      new Ratelimit({
        redis: new Redis({ url: env.upstashRedisUrl, token: env.upstashRedisToken }),
        limiter: Ratelimit.slidingWindow(limit, "60 s"),
        prefix: "skybot:rl",
      }),
    );
  }
  return upstash.get(limit)!;
}

export async function rateLimit(key: string, limit = env.rateLimitPerMinute): Promise<void> {
  const u = await upstashLimiter(limit);
  let ok: boolean;
  if (u) ok = (await u.limit(key)).success;
  else {
    const window = Math.floor(Date.now() / 60_000);
    const cur = mem.get(key);
    if (!cur || cur.window !== window) {
      mem.set(key, { count: 1, window });
      ok = true;
    } else ok = ++cur.count <= limit;
    if (mem.size > 50_000) mem.clear();
  }
  if (!ok) throw Object.assign(new Error("Rate limit exceeded — try again in a minute"), { statusCode: 429 });
}
