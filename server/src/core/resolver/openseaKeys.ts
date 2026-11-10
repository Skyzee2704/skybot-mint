// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSea API key pool. OPENSEA_API_KEYS (comma-separated) wins; otherwise OPENSEA_API_KEY.
 * Wallets are assigned round-robin. Each key has its own 429 cooldown and concurrency,
 * tracked from that key's X-RateLimit headers. The key string is never logged.
 */
import { BUILD_CONCURRENCY } from "../mint/openseaLimit.js";
import { honoredRetryMs, readOpenSeaMintHeaders, type OpenSeaMintSample } from "../mint/openseaLimit.js";

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

class KeyLane {
  inFlight = 0;
  limit: number;
  minLimit: number;
  pauseUntil = 0;
  limitSeen?: number;
  remaining?: number;
  resetRaw?: string;
  private waiters: Array<() => void> = [];

  constructor(
    readonly index: number,
    readonly secret: string,
    readonly max: number,
  ) {
    this.limit = max;
    this.minLimit = max;
  }

  async acquire(sleep: (ms: number) => Promise<void>) {
    for (;;) {
      const now = Date.now();
      if (now < this.pauseUntil) {
        await sleep(this.pauseUntil - now);
        continue;
      }
      if (this.inFlight < this.limit) {
        this.inFlight++;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 429: this key only. Other keys keep sending. */
  penalize(until: number) {
    this.pauseUntil = Math.max(this.pauseUntil, until);
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.minLimit = Math.min(this.minLimit, this.limit);
  }

  succeed() {
    this.limit = Math.min(this.max, this.limit + 1);
  }

  note(sample: OpenSeaMintSample, pending: number) {
    if (sample.limit !== undefined) this.limitSeen = sample.limit;
    if (sample.remaining !== undefined) this.remaining = sample.remaining;
    if (sample.resetRaw) this.resetRaw = sample.resetRaw;
    if (sample.remaining !== undefined && sample.remaining < pending) this.limit = Math.max(1, Math.min(this.limit, sample.remaining));
    if (sample.status !== 429 && sample.status < 400) this.succeed();
  }

  line(): string {
    return `key${this.index} ${this.remaining ?? "?"}/${this.limitSeen ?? "?"}`;
  }
}

let lanes: KeyLane[] | null = null;
let sleepFn: (ms: number) => Promise<void> = sleepReal;

function ensure(): KeyLane[] {
  if (!lanes) lanes = listOpenseaApiKeys().map((secret, index) => new KeyLane(index, secret, BUILD_CONCURRENCY));
  return lanes;
}

export function resetOpenseaKeyPool() {
  lanes = null;
  sleepFn = sleepReal;
}

export function useOpenseaKeySleep(sleep: ((ms: number) => Promise<void>) | null) {
  sleepFn = sleep ?? sleepReal;
}

export function openseaKeyCount(): number {
  return ensure().length;
}

/** Take a turn on the wallet's key. Null when no keys are configured (caller uses its own). */
export async function acquireOpenseaKey(walletIndex: number): Promise<{ index: number; release: () => void } | null> {
  const all = ensure();
  if (!all.length) return null;
  const lane = all[keyIndexForWallet(walletIndex, all.length)]!;
  await lane.acquire(sleepFn);
  return { index: lane.index, release: () => lane.release() };
}

export function openseaKeySecret(index: number): string | undefined {
  return ensure()[index]?.secret;
}

export function noteOpenseaKey(index: number, sample: OpenSeaMintSample, pending = 1) {
  ensure()[index]?.note(sample, pending);
}

export function penalizeOpenseaKey(index: number, until: number) {
  ensure()[index]?.penalize(until);
}

/** Index, remaining, and limit only. Never the key. */
export function openseaKeyLog(): string {
  const all = ensure();
  if (!all.length) return "";
  return all.map((lane) => lane.line()).join(" ");
}

export interface KeyProbe {
  index: number;
  ok: boolean;
  latencyMs: number;
  limit?: number;
  remaining?: number;
  reset?: string;
  error?: string;
}

/** One cheap authenticated read per key. The key itself is not returned. */
export async function testOpenseaKeys(fetchImpl: typeof fetch = fetch): Promise<KeyProbe[]> {
  const all = listOpenseaApiKeys();
  return Promise.all(
    all.map(async (secret, index) => {
      const started = Date.now();
      try {
        const res = await fetchImpl("https://api.opensea.io/api/v2/collections?limit=1", {
          headers: { accept: "application/json", "x-api-key": secret },
        });
        const sample = readOpenSeaMintHeaders(res.headers, res.status);
        return {
          index,
          ok: res.ok,
          latencyMs: Date.now() - started,
          limit: sample.limit,
          remaining: sample.remaining,
          reset: sample.resetRaw,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (e: any) {
        return { index, ok: false, latencyMs: Date.now() - started, error: String(e?.message ?? e).slice(0, 120) };
      }
    }),
  );
}

export function cooldownUntil(sample: OpenSeaMintSample, now = Date.now()): number {
  return now + (honoredRetryMs(sample, now) ?? 500);
}
