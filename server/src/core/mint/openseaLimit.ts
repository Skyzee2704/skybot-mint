// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSea mint calls share the account's token bucket. Polling every wallet until the stage
 * opens can hit ~100 req/s. One probe polls; everyone else waits for that answer, then sends
 * a single mint request. A 429 pauses the whole job and halves concurrency (AIMD).
 */

/** 409 retry while the probe is inside the tight window. 1000/75 ≈ 13 req/s, one wallet. */
export const NOT_ACTIVE_RETRY_MS = 75;
/** Probe's first call is this far before T0. */
export const OPENSEA_LEAD_MS = 150;
/** Last instant (inclusive, relative to T0) that still uses the 75ms probe retry. */
export const OPENSEA_TIGHT_WINDOW_MS = 1_500;
/** Probe waits after the tight window: first 150ms, then 300ms, then the cap. */
export const PROBE_BACKOFF_MS = [150, 300] as const;
export const PROBE_BACKOFF_CAP_MS = 500;
/** Consecutive auth/5xx/timeouts on one probe wallet before the next wallet takes over. */
export const PROBE_PROMOTE_AFTER = 2;
/** Fallback when a 429 has neither Retry-After nor X-RateLimit-Reset. Not a cap. */
export const RATE_LIMIT_RETRY_MS = 500;
/**
 * Pipelines in flight at once. 100 wallets leave in one round trip. The keep-alive agent
 * allows more sockets than this so Privy and the broadcast RPCs still have a connection.
 */
export const BUILD_CONCURRENCY = 100;
/** First parallel mint wave is T0 plus this. 0 sends at the start, not 150ms early. */
export const FIRST_WAVE_OFFSET_MS = 0;

export interface OpenSeaMintSample {
  status: number;
  limit?: number;
  remaining?: number;
  /** Absolute time in ms. */
  resetAt?: number;
  /** X-RateLimit-Reset as OpenSea sent it. Logged, never a secret. */
  resetRaw?: string;
  /** Retry-After in ms, uncapped. */
  retryAfterMs?: number;
}

export type ProbeKind = "ok" | "closed" | "live" | "rate" | "promote" | "fail";

export interface ProbeCall<T> {
  kind: ProbeKind;
  value?: T;
  error?: unknown;
  retryAfterMs?: number;
  resetAt?: number;
  limit?: number;
  remaining?: number;
}

export interface ProbeReport<T> {
  results: Array<{ state: "ok"; value: T } | { state: "error"; error: unknown } | { state: "pending" }>;
  /** Calls made by the probe wallet, including its early attempts and the one that opens the gate. */
  probeAttempts: number;
  /** 409s across the probe and the first wave. */
  notActiveCalls: number;
  /** Wallets that got a 409 on the first wave and were sent again after the stage opened. */
  released: number;
  httpCalls: number;
  rateLimits: number;
  releaseAt?: number;
  minRemaining?: number;
  limitSeen?: number;
  maxInFlight: number;
  minConcurrency: number;
  finalConcurrency: number;
}

/**
 * Pull a retry that would land just after `fireAt` forward so one attempt hits the start.
 */
export function nextRetryDelay(now: number, fireAt: number | undefined, interval = NOT_ACTIVE_RETRY_MS): number {
  if (fireAt !== undefined && now < fireAt && fireAt < now + interval) return fireAt - now;
  return interval;
}

export function inOpenSeaTightWindow(now: number, fireAt: number | undefined): boolean {
  return fireAt !== undefined && now >= fireAt - OPENSEA_LEAD_MS && now <= fireAt + OPENSEA_TIGHT_WINDOW_MS;
}

/** Probe-only 409 wait. Other wallets do not use this. */
export function probeRetryDelay(now: number, fireAt: number | undefined, postWindowWaits: number): number {
  if (inOpenSeaTightWindow(now, fireAt)) return nextRetryDelay(now, fireAt, NOT_ACTIVE_RETRY_MS);
  const step = postWindowWaits >= PROBE_BACKOFF_MS.length ? PROBE_BACKOFF_CAP_MS : PROBE_BACKOFF_MS[postWindowWaits]!;
  return nextRetryDelay(now, fireAt, step);
}

export function parseRetryAfterMs(raw: string | null | undefined, now: number): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

/** X-RateLimit-Reset: unix ms, unix seconds, or a small delta in seconds. */
export function parseResetAt(raw: string | null | undefined, now: number): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 1e12) return n;
  if (n >= 1e9) return n * 1000;
  return now + Math.round(n * 1000);
}

function parseCount(raw: string | null): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export function readOpenSeaMintHeaders(headers: Headers, status: number, now = Date.now()): OpenSeaMintSample {
  const resetRaw = headers.get("x-ratelimit-reset")?.trim().slice(0, 40);
  return {
    status,
    limit: parseCount(headers.get("x-ratelimit-limit")),
    remaining: parseCount(headers.get("x-ratelimit-remaining")),
    resetAt: parseResetAt(headers.get("x-ratelimit-reset"), now),
    resetRaw: resetRaw || undefined,
    retryAfterMs: parseRetryAfterMs(headers.get("retry-after"), now),
  };
}

/** How long a 429 must wait. The only ceiling is the build deadline. */
export function rateLimitWaitMs(
  now: number,
  deadline: number,
  sample: { retryAfterMs?: number; resetAt?: number },
  fallback = RATE_LIMIT_RETRY_MS,
): number {
  const fromReset = sample.resetAt !== undefined ? sample.resetAt - now : undefined;
  const hinted = [sample.retryAfterMs, fromReset].filter((n): n is number => n !== undefined && n > 0);
  const wait = hinted.length ? Math.max(...hinted) : fallback;
  return Math.min(wait, Math.max(0, deadline - now));
}

export function honoredRetryMs(sample: { retryAfterMs?: number; resetAt?: number }, now: number): number | undefined {
  const fromReset = sample.resetAt !== undefined ? sample.resetAt - now : undefined;
  const hinted = [sample.retryAfterMs, fromReset].filter((n): n is number => n !== undefined && n > 0);
  return hinted.length ? Math.max(...hinted) : undefined;
}

/** First headers, lowest remaining, and how many 429s this job saw. */
export class MintRateLog {
  seen = false;
  rateLimits = 0;
  first?: { limit?: number; remaining?: number; reset?: string };
  lowest?: { limit?: number; remaining: number; reset?: string };
  latest?: { limit?: number; remaining?: number };

  note(sample: OpenSeaMintSample) {
    this.seen = true;
    if (sample.status === 429) this.rateLimits++;
    if (sample.limit !== undefined || sample.remaining !== undefined) {
      this.latest = { limit: sample.limit ?? this.latest?.limit, remaining: sample.remaining ?? this.latest?.remaining };
    }
    const hasHeader = sample.limit !== undefined || sample.remaining !== undefined || sample.resetRaw !== undefined;
    if (!hasHeader) return;
    if (!this.first) this.first = { limit: sample.limit, remaining: sample.remaining, reset: sample.resetRaw };
    if (sample.remaining !== undefined && (this.lowest === undefined || sample.remaining < this.lowest.remaining)) {
      this.lowest = { limit: sample.limit ?? this.latest?.limit, remaining: sample.remaining, reset: sample.resetRaw };
    }
  }

  format(): string {
    const one = (x: { limit?: number; remaining?: number; reset?: string } | undefined) =>
      x ? `${x.limit ?? "?"}/${x.remaining ?? "?"} reset ${x.reset ?? "?"}` : "none";
    return `os first ${one(this.first)} lowest ${one(this.lowest)} 429s ${this.rateLimits}`;
  }
}

/** Multiplicative decrease on 429, additive increase on success, capped by Remaining when it is tight. */
export class AimdConcurrency {
  limit: number;
  minLimit: number;
  constructor(readonly max: number) {
    this.limit = Math.max(1, max);
    this.minLimit = this.limit;
  }
  private set(n: number) {
    this.limit = Math.max(1, Math.min(this.max, Math.floor(n)));
    this.minLimit = Math.min(this.minLimit, this.limit);
  }
  halve() {
    this.set(this.limit / 2);
  }
  onSuccess() {
    this.set(this.limit + 1);
  }
  /** If Remaining cannot cover the wallets still waiting, do not outrun it. */
  capToRemaining(remaining: number | undefined, pending: number) {
    if (remaining === undefined || remaining >= pending) return;
    this.set(Math.min(this.limit, Math.max(1, remaining)));
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * The probe polls from T0−150ms. At T0 + FIRST_WAVE_OFFSET_MS every wallet fires once. A 409 parks
 * that wallet. Only the probe keeps polling. When the stage is open, parked wallets each get one
 * more request. A success goes straight to `onOk` (sign and broadcast) with no extra wait.
 */
export async function probeAndRelease<T>(opts: {
  count: number;
  fireAt?: number;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tick?: () => Promise<void>;
  /** Added to T0 for the first parallel wave. Defaults to FIRST_WAVE_OFFSET_MS (0). */
  waveOffsetMs?: number;
  /** When set, a 429 does not pause every wallet. The OpenSea key pool cools down that key only. */
  isolateRateLimits?: boolean;
  maxConcurrency?: number;
  call: (index: number) => Promise<ProbeCall<T>>;
  onOk?: (index: number, value: T) => Promise<void>;
  onFail?: (index: number, error: unknown) => Promise<void>;
}): Promise<ProbeReport<T>> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const tick = opts.tick ?? (async () => {});
  const conc = new AimdConcurrency(opts.maxConcurrency ?? BUILD_CONCURRENCY);
  const results: ProbeReport<T>["results"] = Array.from({ length: opts.count }, () => ({ state: "pending" }));
  let probeAttempts = 0;
  let notActiveCalls = 0;
  let released = 0;
  let httpCalls = 0;
  let rateLimits = 0;
  let releaseAt: number | undefined;
  let minRemaining: number | undefined;
  let limitSeen: number | undefined;
  let maxInFlight = 0;
  let inFlight = 0;
  let pauseUntil = 0;
  let stop: unknown;
  const tails: Promise<void>[] = [];

  const noteSample = (res: ProbeCall<T>) => {
    if (res.limit !== undefined) limitSeen ??= res.limit;
    if (res.remaining !== undefined) minRemaining = minRemaining === undefined ? res.remaining : Math.min(minRemaining, res.remaining);
    if (res.kind === "rate") rateLimits++;
  };

  const waitPause = async () => {
    const t = now();
    if (t < pauseUntil) await sleep(Math.min(pauseUntil - t, Math.max(0, opts.deadline - t)));
    await tick();
  };

  async function settle(i: number, res: ProbeCall<T>, holdSlot: boolean) {
    const run =
      res.kind === "ok" && opts.onOk
        ? opts.onOk(i, res.value as T)
        : res.kind !== "ok" && res.kind !== "closed" && res.kind !== "rate" && opts.onFail
          ? opts.onFail(i, res.error)
          : undefined;
    if (!run) return;
    if (holdSlot) await run;
    else tails.push(run.catch((e) => void (stop ??= e)));
  }

  const applyRate = (res: ProbeCall<T>) => {
    conc.halve();
    const wait = rateLimitWaitMs(now(), opts.deadline, res);
    pauseUntil = Math.max(pauseUntil, now() + wait);
    conc.capToRemaining(res.remaining, parked.size + results.filter((r) => r.state === "pending").length);
  };

  const parked = new Set<number>();
  let probe = 0;
  let probeClosedInWave = false;
  let opened = false;
  let strikes = 0;
  let postWindow = 0;

  const waveAt = opts.fireAt === undefined ? now() : opts.fireAt + (opts.waveOffsetMs ?? FIRST_WAVE_OFFSET_MS);

  async function issue(i: number): Promise<ProbeCall<T>> {
    await waitPause();
    if (now() >= opts.deadline) return { kind: "fail", error: new Error("build deadline") };
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    httpCalls++;
    if (i === probe) probeAttempts++;
    try {
      return await opts.call(i);
    } finally {
      inFlight--;
    }
  }

  function remember(i: number, res: ProbeCall<T>) {
    if (res.kind === "ok") {
      results[i] = { state: "ok", value: res.value as T };
      conc.onSuccess();
      opened = true;
      releaseAt ??= now();
    } else if (res.kind === "live" || res.kind === "fail" || res.kind === "promote") {
      results[i] = { state: "error", error: res.error ?? new Error(res.kind) };
      if (res.kind === "live") {
        opened = true;
        releaseAt ??= now();
      }
    }
    conc.capToRemaining(res.remaining, parked.size + results.filter((r) => r.state === "pending").length);
  }

  /** Probe poll. "closed" and "rate" both mean try again; only "closed" waits out the 409 interval. */
  async function pollProbe(): Promise<"open" | "closed" | "rate" | "stop"> {
    if (stop) throw stop;
    const res = await issue(probe);
    noteSample(res);
    if (res.kind === "closed") {
      strikes = 0;
      notActiveCalls++;
      return "closed";
    }
    if (res.kind === "rate") {
      strikes = 0;
      if (!opts.isolateRateLimits) applyRate(res);
      return "rate";
    }
    if (res.kind === "promote") {
      strikes++;
      if (strikes < PROBE_PROMOTE_AFTER) return "closed";
    }
    if (res.kind === "promote" || res.kind === "fail") {
      remember(probe, res);
      void settle(probe, res, false);
      const next = results.findIndex((r, i) => i !== probe && r.state === "pending" && !parked.has(i));
      strikes = 0;
      postWindow = 0;
      if (next < 0) return "stop";
      probe = next;
      parked.delete(probe);
      return "rate";
    }
    remember(probe, res);
    void settle(probe, res, false);
    return "open";
  }

  async function sleepProbe() {
    const t = now();
    const delay = probeRetryDelay(t, opts.fireAt, postWindow);
    if (!inOpenSeaTightWindow(t, opts.fireAt)) postWindow++;
    const slice = Math.min(delay, Math.max(0, opts.deadline - t), opened ? delay : Math.max(0, waveAt - t) || delay);
    if (slice > 0) await sleep(slice);
    await tick();
  }

  // Early probe only. Everyone else waits for T0 so a closed stage does not cost them a request yet.
  if (opts.count > 0 && now() < waveAt) {
    while (!opened && now() < waveAt && now() < opts.deadline) {
      const step = await pollProbe();
      if (step === "stop" || step === "open") break;
      if (now() >= waveAt) break;
      if (step === "closed") await sleepProbe();
    }
  }

  async function pool(initial: number[], mode: "first" | "follow") {
    const queue = [...initial];
    if (!queue.length) return;
    await new Promise<void>((resolve, reject) => {
      let pumping = false;
      const pump = () => {
        if (stop) return reject(stop);
        if (pumping) return;
        pumping = true;
        try {
          while (queue.length && inFlight < conc.limit && now() >= pauseUntil && now() < opts.deadline) {
            const i = queue.shift()!;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            httpCalls++;
            if (i === probe) probeAttempts++;
            void (async () => {
              try {
                await waitPause();
                const res: ProbeCall<T> =
                  now() >= opts.deadline ? { kind: "fail", error: new Error("build deadline") } : await opts.call(i);
                noteSample(res);
                if (res.kind === "rate") {
                  if (!opts.isolateRateLimits) applyRate(res);
                  queue.push(i);
                  return;
                }
                if (res.kind === "closed") {
                  notActiveCalls++;
                  if (mode === "first" && i === probe && !opened) {
                    probeClosedInWave = true;
                    return;
                  }
                  if (mode === "first") {
                    parked.add(i);
                    return;
                  }
                  results[i] = { state: "error", error: res.error ?? new Error("not active") };
                  await settle(i, res, true);
                  return;
                }
                remember(i, res);
                await settle(i, res, true);
              } catch (e) {
                stop ??= e;
              } finally {
                inFlight--;
                pumping = false;
                pump();
              }
            })();
          }
        } finally {
          pumping = false;
        }
        if (queue.length && inFlight === 0 && now() < pauseUntil && now() < opts.deadline) {
          void sleep(Math.min(pauseUntil - now(), Math.max(0, opts.deadline - now())))
            .then(() => tick())
            .then(() => pump())
            .catch(reject);
          return;
        }
        if (!queue.length && inFlight === 0) resolve();
      };
      pump();
    });
  }

  const stillWaiting = () => results.map((r, i) => (r.state === "pending" && !parked.has(i) ? i : -1)).filter((i) => i >= 0);

  if (opened) {
    // The probe already saw the stage open. Everyone else sends once, immediately.
    const rest = stillWaiting();
    await pool(rest, "follow");
  } else if (opts.count > 0) {
    if (now() < waveAt) await sleep(Math.max(0, waveAt - now()));
    await tick();
    await pool(stillWaiting(), "first");
    if (!opened && now() < opts.deadline && results[probe]?.state === "pending") {
      if (probeClosedInWave) await sleepProbe();
      while (!opened && now() < opts.deadline) {
        const step = await pollProbe();
        if (step === "stop" || step === "open") break;
        if (step === "closed") await sleepProbe();
      }
    }
    if (parked.size) {
      const again = [...parked];
      parked.clear();
      released += again.length;
      releaseAt ??= now();
      await pool(again, "follow");
    }
  }

  await Promise.all(tails);
  if (stop) throw stop;

  return {
    results,
    probeAttempts,
    notActiveCalls,
    released,
    httpCalls,
    rateLimits,
    releaseAt,
    minRemaining,
    limitSeen,
    maxInFlight,
    minConcurrency: conc.minLimit,
    finalConcurrency: conc.limit,
  };
}
