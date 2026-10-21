// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Short per-instance cache for native balances (default 15 s) so page reloads and the Mint/Wallets pages
 * don't hammer RPCs. Concurrent lookups for the same chain+address share one in-flight request.
 */
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; p: Promise<bigint> }>();

export function cachedBalance(chain: string, address: string, load: () => Promise<bigint>, ttlMs = TTL_MS): Promise<bigint> {
  const k = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = load();
  cache.set(k, { at: Date.now(), p });
  p.catch(() => cache.delete(k));
  if (cache.size > 5000) for (const [key, v] of cache) if (Date.now() - v.at > ttlMs) cache.delete(key);
  return p;
}

export function clearBalanceCache() {
  cache.clear();
}
