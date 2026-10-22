// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-instance cache for native balances (default 30 s) so page reloads and the Mint / Wallets / Withdraw pages
 * don't hammer RPCs. Concurrent lookups for the same chain + address share one in-flight request, and a batch of
 * misses is loaded with ONE multicall. Critical paths (withdraw quote, wallet removal, NFT send) pass `fresh`.
 */
export const BALANCE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<bigint> }>();
const k = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

function prune(ttlMs: number) {
  if (cache.size > 5000) for (const [key, v] of cache) if (Date.now() - v.at > ttlMs) cache.delete(key);
}

export function cachedBalance(chain: string, address: string, load: () => Promise<bigint>, ttlMs = BALANCE_TTL_MS): Promise<bigint> {
  const key = k(chain, address);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  prune(ttlMs);
  return p;
}

/**
 * Many balances on one chain: cache hits are reused, all misses are loaded together via `loadMany` (one multicall).
 * `fresh: true` ignores the cache (but still stores the result for later non-critical reads).
 */
export async function cachedBalances(
  chain: string,
  addresses: string[],
  loadMany: (missing: string[]) => Promise<Map<string, bigint>>,
  opts: { ttlMs?: number; fresh?: boolean; changedAt?: Map<string, number> } = {},
): Promise<Map<string, bigint | Error>> {
  const ttlMs = opts.ttlMs ?? BALANCE_TTL_MS;
  const now = Date.now();
  const missing: string[] = [];
  const pending = new Map<string, Promise<bigint>>();
  for (const a of new Set(addresses.map((x) => x.toLowerCase()))) {
    const hit = cache.get(k(chain, a));
    // A webhook-reported transfer newer than the cached value makes it stale on every instance.
    const changed = opts.changedAt?.get(a) ?? 0;
    if (!opts.fresh && hit && now - hit.at < ttlMs && hit.at > changed) pending.set(a, hit.p);
    else missing.push(a);
  }
  if (missing.length) {
    const batch = loadMany(missing);
    for (const a of missing) {
      const p = batch.then((m) => {
        const v = m.get(a);
        if (v === undefined) throw new Error("balance unavailable");
        return v;
      });
      p.catch(() => cache.delete(k(chain, a)));
      cache.set(k(chain, a), { at: now, p });
      pending.set(a, p);
    }
    prune(ttlMs);
  }
  const out = new Map<string, bigint | Error>();
  await Promise.all(
    [...pending].map(async ([a, p]) => {
      try {
        out.set(a, await p);
      } catch (e: any) {
        out.set(a, e instanceof Error ? e : new Error(String(e)));
      }
    }),
  );
  return out;
}

/** Oldest cache time among these addresses (what the UI shows as "Updated … ago"). */
export function balancesAsOf(chain: string, addresses: string[]): number {
  let at = Date.now();
  for (const a of addresses) {
    const hit = cache.get(k(chain, a));
    if (hit) at = Math.min(at, hit.at);
  }
  return at;
}

/** Drop cached balances after a transfer so the next read is fresh. */
export function invalidateBalances(chain: string, addresses: string[]) {
  for (const a of addresses) cache.delete(k(chain, a));
}

export function clearBalanceCache() {
  cache.clear();
}
