import { JsonRpcProvider, Network, keccak256 } from "ethers";
import { ChainConfig, rpcsForChain } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { log } from "../../util/log.js";

/**
 * RPC pool with rotation, cooldown, retry/backoff and broadcast fan-out.
 * - Reads: try the healthiest endpoint first; on transport errors / rate limits / timeouts the
 *   endpoint is put on cooldown and the next one is tried (exponential backoff between rounds).
 * - Contract reverts and other deterministic errors are NOT retried (they would fail everywhere).
 * - Every endpoint's eth_chainId is verified once; mismatching endpoints are disabled.
 * - Broadcast: the signed raw tx is POSTed to every endpoint (incl. send-only) in parallel.
 */
export interface Endpoint {
  url: string;
  provider: JsonRpcProvider;
  failures: number;
  cooldownUntil: number;
  verified: boolean;
  disabled: boolean;
  lastError?: string;
  sendOnly: boolean;
}

const NON_RETRYABLE = new Set([
  "CALL_EXCEPTION", "INVALID_ARGUMENT", "INSUFFICIENT_FUNDS", "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED", "BAD_DATA", "UNSUPPORTED_OPERATION", "NUMERIC_FAULT",
]);

export function isRetryable(err: any): boolean {
  if (!err) return false;
  if (err.code && NON_RETRYABLE.has(err.code)) {
    // Some public RPCs wrap rate limits as CALL_EXCEPTION with no data; detect text.
    const m = String(err.shortMessage ?? err.message ?? "").toLowerCase();
    return /rate limit|too many requests|429|exceeded|capacity/.test(m);
  }
  return true; // network errors, timeouts, SERVER_ERROR, UNKNOWN_ERROR, 5xx, rate limits
}

/** Host only — paths often carry API keys (e.g. Alchemy /v2/<key>), so they are always masked. */
export function shortUrl(u: string) {
  try { const x = new URL(u); return x.host + (x.pathname.length > 1 || x.search ? "/***" : ""); } catch { return "rpc"; }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms}ms (${label})`), { code: "TIMEOUT" })), ms); }),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ json(): Promise<any> }>;

export class RpcPool {
  readonly endpoints: Endpoint[];
  private readonly network: Network;
  constructor(
    readonly chain: ChainConfig,
    urls?: { read: string[]; send: string[] },
    private readonly opts: { timeoutMs?: number; maxRounds?: number; baseBackoffMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    const r = urls ?? rpcsForChain(chain);
    this.network = Network.from(chain.chainId);
    const mk = (url: string, sendOnly: boolean): Endpoint => ({
      url, sendOnly, failures: 0, cooldownUntil: 0, verified: false, disabled: false,
      provider: new JsonRpcProvider(url, this.network, { staticNetwork: this.network, batchMaxCount: 1 }),
    });
    const readSet = new Set(r.read);
    this.endpoints = [...r.read.map((u) => mk(u, false)), ...r.send.filter((u) => !readSet.has(u)).map((u) => mk(u, true))];
  }

  private get timeoutMs() { return this.opts.timeoutMs ?? env.rpcTimeoutMs; }

  /** Order: not disabled, not cooling down, fewest failures, original priority. */
  ordered(now = Date.now()): Endpoint[] {
    const ok = this.endpoints.filter((e) => !e.disabled && !e.sendOnly);
    const ready = ok.filter((e) => e.cooldownUntil <= now).sort((a, b) => a.failures - b.failures);
    const cooling = ok.filter((e) => e.cooldownUntil > now).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...ready, ...cooling];
  }

  markFailure(e: Endpoint, err: unknown) {
    e.failures++;
    const msg = String((err as any)?.shortMessage ?? (err as any)?.message ?? err);
    e.lastError = msg.slice(0, 160);
    const rateLimited = /429|rate|too many|limit/i.test(msg);
    e.cooldownUntil = Date.now() + Math.min(60_000, (rateLimited ? 5000 : 1000) * 2 ** Math.min(e.failures - 1, 5));
  }
  markSuccess(e: Endpoint) { e.failures = Math.max(0, e.failures - 1); e.cooldownUntil = 0; }

  private async verify(e: Endpoint) {
    if (e.verified) return;
    const raw = await withTimeout(e.provider.send("eth_chainId", []), this.timeoutMs, "eth_chainId");
    const id = Number(BigInt(raw));
    if (id !== this.chain.chainId) {
      e.disabled = true;
      e.lastError = `chainId mismatch: got ${id}, expected ${this.chain.chainId}`;
      log.warn(`RPC ${shortUrl(e.url)} disabled: ${e.lastError}`);
      throw Object.assign(new Error(e.lastError), { code: "CHAIN_MISMATCH" });
    }
    e.verified = true;
  }

  /** Run a read against the pool with rotation + backoff. */
  async read<T>(fn: (p: JsonRpcProvider) => Promise<T>, label = "read"): Promise<T> {
    const maxRounds = this.opts.maxRounds ?? 3;
    let lastErr: unknown;
    for (let round = 0; round < maxRounds; round++) {
      const list = this.ordered();
      if (list.length === 0) throw new Error(`No usable RPC endpoints for ${this.chain.name}`);
      for (const e of list) {
        try {
          await this.verify(e);
          const out = await withTimeout(fn(e.provider), this.timeoutMs, label);
          this.markSuccess(e);
          return out;
        } catch (err: any) {
          if (err?.code === "CHAIN_MISMATCH") { lastErr = err; continue; }
          if (!isRetryable(err)) throw err;
          lastErr = err;
          this.markFailure(e, err);
        }
      }
      await sleep((this.opts.baseBackoffMs ?? 250) * 2 ** round);
    }
    throw Object.assign(new Error(`All RPCs failed for ${label} on ${this.chain.name}: ${(lastErr as any)?.shortMessage ?? (lastErr as any)?.message ?? lastErr}`), { code: "RPC_EXHAUSTED", cause: lastErr });
  }

  /** Verify the pool is on the expected chain (at least one endpoint answers with the right id). */
  async checkChainId(): Promise<number> {
    const id = await this.read(async (p) => Number(BigInt(await p.send("eth_chainId", []))), "eth_chainId");
    if (id !== this.chain.chainId) throw new Error(`chainId mismatch: ${id} != ${this.chain.chainId}`);
    return id;
  }

  /** Broadcast a signed tx to every enabled endpoint in parallel. */
  async broadcast(rawTx: string): Promise<{ hash: string; accepted: string[]; errors: { url: string; error: string }[] }> {
    const hash = keccak256(rawTx);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [rawTx] });
    const f: FetchLike = this.opts.fetchImpl ?? (globalThis.fetch as any);
    const targets = this.endpoints.filter((e) => !e.disabled);
    const results = await Promise.allSettled(targets.map(async (e) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await f(e.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl.signal });
        const j = await res.json();
        if (j?.result) return { url: e.url, ok: true };
        const msg = String(j?.error?.message ?? "unknown error");
        if (/already known|already exists|known transaction|already imported/i.test(msg)) return { url: e.url, ok: true };
        return { url: e.url, ok: false, error: msg };
      } finally { clearTimeout(t); }
    }));
    const accepted: string[] = []; const errors: { url: string; error: string }[] = [];
    results.forEach((r, i) => {
      const url = targets[i].url;
      if (r.status === "fulfilled" && r.value.ok) accepted.push(url);
      else errors.push({ url, error: r.status === "fulfilled" ? (r.value as any).error : String((r.reason as any)?.message ?? r.reason) });
    });
    return { hash, accepted, errors };
  }

  status() {
    return this.endpoints.map((e) => ({
      url: shortUrl(e.url), sendOnly: e.sendOnly, disabled: e.disabled, failures: e.failures,
      coolingDown: e.cooldownUntil > Date.now(), lastError: e.lastError ?? null,
    }));
  }
}

const pools = new Map<string, RpcPool>();
export function getPool(chain: ChainConfig): RpcPool {
  let p = pools.get(chain.key);
  if (!p) { p = new RpcPool(chain); pools.set(chain.key, p); }
  return p;
}
export function resetPools() { pools.clear(); }
