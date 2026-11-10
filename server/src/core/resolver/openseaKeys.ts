// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One OpenSea key pool for every user and every job.
 * OPENSEA_API_KEYS (comma-separated, one key per OpenSea account) wins; otherwise OPENSEA_API_KEY.
 * Mint calls are served first. A 429 or 401/403 cools that key down and the same call moves to the
 * next healthy key immediately. State is in-process. When Upstash Redis is configured, cooldowns are
 * also written there so other instances see them; the hot path never waits on Redis.
 * Key strings are never logged.
 */
import { BUILD_CONCURRENCY } from "../mint/openseaLimit.js";
import { honoredRetryMs, readOpenSeaMintHeaders, type OpenSeaMintSample } from "../mint/openseaLimit.js";
import { env } from "../../config/env.js";

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export function listOpenseaApiKeys(fromKeys = process.env.OPENSEA_API_KEYS, fromKey = process.env.OPENSEA_API_KEY): string[] {
  const many = (fromKeys ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (many.length) return many;
  const one = fromKey?.trim();
  return one ? [one] : [];
}

export function keyIndexForWallet(walletIndex: number, keyCount: number): number {
  if (keyCount <= 0) return 0;
  const i = walletIndex % keyCount;
  return i < 0 ? i + keyCount : i;
}

/** 429 or a rejected key. A 409 means the stage is closed, not that the key failed. */
export function keyShouldRotate(status: number): boolean {
  return status === 429 || status === 401 || status === 403;
}

class Lane {
  inFlight = 0;
  limit: number;
  pauseUntil = 0;
  limitSeen?: number;
  remaining?: number;
  resetRaw?: string;
  latencyMs?: number;

  constructor(
    readonly index: number,
    readonly secret: string,
    readonly max: number,
  ) {
    this.limit = max;
  }

  get cooling(): boolean {
    return Date.now() < this.pauseUntil;
  }

  note(sample: OpenSeaMintSample, authIsKey = false) {
    if (sample.limit !== undefined) this.limitSeen = sample.limit;
    if (sample.remaining !== undefined) this.remaining = sample.remaining;
    if (sample.resetRaw) this.resetRaw = sample.resetRaw;
    if (sample.remaining === 0) {
      const until = sample.resetAt ?? Date.now() + 1_000;
      this.pauseUntil = Math.max(this.pauseUntil, until);
    }
    if (sample.status === 429) this.penalize(sample);
    else if (authIsKey && (sample.status === 401 || sample.status === 403))
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + 60_000);
    else if (sample.status > 0 && sample.status < 400) this.limit = Math.min(this.max, this.limit + 1);
    persist(this);
  }

  penalize(sample?: OpenSeaMintSample) {
    const until = sample ? Date.now() + (honoredRetryMs(sample, Date.now()) ?? 1_000) : this.pauseUntil;
    if (sample) this.pauseUntil = Math.max(this.pauseUntil, until);
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    persist(this);
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const wake = mintWaiters.shift() ?? backgroundWaiters.shift();
    if (wake) wake();
  }
}

let lanes: Lane[] | null = null;
let cursor = 0;
let mintWaiting = 0;
const mintWaiters: Array<() => void> = [];
const backgroundWaiters: Array<() => void> = [];
let hydrated = false;

function perKeyMax(count: number): number {
  return Math.max(4, Math.ceil(BUILD_CONCURRENCY / Math.max(1, count)));
}

function ensure(fallback?: string): Lane[] {
  if (!lanes) {
    const fromEnv = listOpenseaApiKeys();
    const secrets = fromEnv.length ? fromEnv : fallback ? [fallback] : [];
    const max = perKeyMax(secrets.length);
    lanes = secrets.map((secret, index) => new Lane(index, secret, max));
    cursor = 0;
    if (!hydrated) {
      hydrated = true;
      void hydrate();
    }
  }
  return lanes;
}

export function resetOpenseaKeyPool() {
  lanes = null;
  cursor = 0;
  mintWaiting = 0;
  mintWaiters.length = 0;
  backgroundWaiters.length = 0;
  hydrated = false;
}

export function openseaKeyCount(fallback?: string): number {
  return ensure(fallback).length;
}

function tryPick(priority: "mint" | "background", skipped: Set<number>): Lane | null {
  const all = lanes ?? [];
  const n = all.length;
  if (!n) return null;
  if (priority === "background" && mintWaiting > 0) return null;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const idx = (cursor + i) % n;
    const lane = all[idx]!;
    if (skipped.has(idx) || now < lane.pauseUntil || lane.inFlight >= lane.limit) continue;
    cursor = (idx + 1) % n;
    lane.inFlight++;
    return lane;
  }
  return null;
}

function soonestPause(skipped: Set<number>): number {
  const times = (lanes ?? []).filter((lane) => !skipped.has(lane.index)).map((lane) => lane.pauseUntil);
  return times.length ? Math.min(...times) : Date.now();
}

async function takeLane(priority: "mint" | "background", skipped: Set<number>): Promise<Lane | null> {
  if (priority === "mint") mintWaiting++;
  try {
    for (;;) {
      const lane = tryPick(priority, skipped);
      if (lane) return lane;
      const all = lanes ?? [];
      if (!all.length || skipped.size >= all.length) return null;
      const waitMs =
        priority === "background" && mintWaiting > 0
          ? 5
          : Math.max(1, Math.min(priority === "mint" ? 30_000 : 200, soonestPause(skipped) - Date.now()));
      await new Promise<void>((resolve) => {
        const list = priority === "mint" ? mintWaiters : backgroundWaiters;
        const timer = setTimeout(
          () => {
            const at = list.indexOf(done);
            if (at >= 0) list.splice(at, 1);
            resolve();
          },
          Math.max(1, waitMs),
        );
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        list.push(done);
      });
    }
  } finally {
    if (priority === "mint") mintWaiting--;
  }
}

let redisClient: any;

async function redis() {
  if (redisClient !== undefined) return redisClient;
  if (!env.upstashRedisUrl || !env.upstashRedisToken) return (redisClient = null);
  try {
    const { Redis } = await import("@upstash/redis");
    redisClient = new Redis({ url: env.upstashRedisUrl, token: env.upstashRedisToken });
    return redisClient;
  } catch {
    return (redisClient = null);
  }
}

function persist(lane: Lane) {
  void redis()
    .then((client) =>
      client?.set(
        `skybot:oskey:${lane.index}`,
        JSON.stringify({
          pauseUntil: lane.pauseUntil,
          limit: lane.limit,
          remaining: lane.remaining ?? null,
          limitSeen: lane.limitSeen ?? null,
          resetRaw: lane.resetRaw ?? null,
        }),
        { ex: 120 },
      ),
    )
    .catch(() => {});
}

async function hydrate() {
  const client = await Promise.race([redis(), sleepReal(150).then(() => null)]);
  if (!client || !lanes) return;
  await Promise.all(
    lanes.map(async (lane) => {
      try {
        const raw = await client.get(`skybot:oskey:${lane.index}`);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== "object") return;
        const row = parsed as {
          pauseUntil?: number;
          limit?: number;
          remaining?: number | null;
          limitSeen?: number | null;
          resetRaw?: string | null;
        };
        if (typeof row.pauseUntil === "number") lane.pauseUntil = Math.max(lane.pauseUntil, row.pauseUntil);
        if (typeof row.limit === "number") lane.limit = Math.max(1, Math.min(lane.max, row.limit));
        if (typeof row.remaining === "number") lane.remaining = row.remaining;
        if (typeof row.limitSeen === "number") lane.limitSeen = row.limitSeen;
        if (typeof row.resetRaw === "string") lane.resetRaw = row.resetRaw;
      } catch {
        /* in-process state still works */
      }
    }),
  );
}

export type OpenSeaPriority = "mint" | "background";

/**
 * One OpenSea HTTP call. Walks healthy keys, mint first, and rotates immediately on 429/401/403.
 * Returns the last response when every key fails that way.
 */
export async function openseaFetch(opts: {
  priority: OpenSeaPriority;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  fallbackKey?: string;
  allowNoKey?: boolean;
  onSample?: (sample: OpenSeaMintSample) => void;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const all = ensure(opts.fallbackKey);
  if (!all.length) {
    if (opts.allowNoKey) {
      return fetchImpl(opts.url, { method: opts.method, headers: opts.headers, body: opts.body, signal: opts.signal });
    }
    throw new Error("OPENSEA_API_KEY not set");
  }
  const skipped = new Set<number>();
  let last: Response | null = null;
  for (let n = 0; n < all.length; n++) {
    const lane = await takeLane(opts.priority, skipped);
    if (!lane) break;
    try {
      const headers = { accept: "application/json", ...opts.headers, "x-api-key": lane.secret };
      const res = await fetchImpl(opts.url, { method: opts.method, headers, body: opts.body, signal: opts.signal });
      const sample = readOpenSeaMintHeaders(res.headers, res.status);
      const hasBearer = Boolean(opts.headers?.authorization || opts.headers?.Authorization);
      lane.note(sample, !hasBearer);
      opts.onSample?.(sample);
      if (keyShouldRotate(res.status)) {
        skipped.add(lane.index);
        last = res;
        continue;
      }
      return res;
    } finally {
      lane.release();
    }
  }
  if (last) return last;
  throw new Error("OpenSea keys are cooling down");
}

export function openseaKeyLog(): string {
  const all = lanes ?? [];
  if (!all.length) return "";
  const now = Date.now();
  return all
    .map((lane) => `key${lane.index} ${lane.remaining ?? "?"}/${lane.limitSeen ?? "?"} cool ${Math.max(0, lane.pauseUntil - now)}ms`)
    .join(" ");
}

/** @deprecated Sticky acquire. Prefer openseaFetch, which rotates on failure. */
export async function acquireOpenseaKey(start = 0): Promise<{ index: number; release: () => void } | null> {
  const all = ensure();
  if (!all.length) return null;
  const skip = new Set<number>();
  const cooled = all[keyIndexForWallet(start, all.length)];
  if (cooled?.cooling) skip.add(cooled.index);
  const lane = await takeLane("mint", skip);
  if (!lane) return null;
  return { index: lane.index, release: () => lane.release() };
}

export function penalizeOpenseaKey(index: number, until: number) {
  const lane = ensure()[index];
  if (!lane) return;
  lane.pauseUntil = Math.max(lane.pauseUntil, until);
  lane.limit = Math.max(1, Math.floor(lane.limit / 2));
  persist(lane);
}

export function openseaKeySecret(index: number): string | undefined {
  return ensure()[index]?.secret;
}

export interface KeyProbe {
  index: number;
  ok: boolean;
  latencyMs: number;
  limit?: number;
  remaining?: number;
  reset?: string;
  cooldownMs: number;
  concurrency: number;
  error?: string;
}

/** Live probe plus the in-process cooldown. The key itself is not returned. */
export async function testOpenseaKeys(fetchImpl: typeof fetch = fetch): Promise<KeyProbe[]> {
  const all = listOpenseaApiKeys();
  ensure();
  return Promise.all(
    all.map(async (secret, index) => {
      const started = Date.now();
      const lane = ensure()[index];
      try {
        const res = await fetchImpl("https://api.opensea.io/api/v2/collections?limit=1", {
          headers: { accept: "application/json", "x-api-key": secret },
        });
        const sample = readOpenSeaMintHeaders(res.headers, res.status);
        lane?.note(sample);
        return {
          index,
          ok: res.ok,
          latencyMs: Date.now() - started,
          limit: sample.limit ?? lane?.limitSeen,
          remaining: sample.remaining ?? lane?.remaining,
          reset: sample.resetRaw ?? lane?.resetRaw,
          cooldownMs: Math.max(0, (lane?.pauseUntil ?? 0) - Date.now()),
          concurrency: lane?.limit ?? 0,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (e: any) {
        return {
          index,
          ok: false,
          latencyMs: Date.now() - started,
          cooldownMs: Math.max(0, (lane?.pauseUntil ?? 0) - Date.now()),
          concurrency: lane?.limit ?? 0,
          error: String(e?.message ?? e).slice(0, 120),
        };
      }
    }),
  );
}
