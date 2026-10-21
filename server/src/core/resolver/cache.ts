// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedTarget } from "./resolver.js";
import { resolveTarget } from "./resolver.js";

/** Server-side cache of resolved targets so mint requests never trust client-provided ABI/price data. */
const cache = new Map<string, { at: number; t: ResolvedTarget }>();
const TTL = 10 * 60_000;
export const cacheKey = (chain: string, contract: string) => `${chain}:${contract.toLowerCase()}`;

export function remember(t: ResolvedTarget) {
  cache.set(cacheKey(t.chain.key, t.contract), { at: Date.now(), t });
  return t;
}
export async function getResolved(chain: string, contract: string, input?: string): Promise<ResolvedTarget> {
  const hit = cache.get(cacheKey(chain, contract));
  if (hit && Date.now() - hit.at < TTL) return hit.t;
  return remember(await resolveTarget({ input: input ?? contract, chain }));
}
export async function refresh(chain: string, contract: string, input?: string) {
  return remember(await resolveTarget({ input: input ?? contract, chain }));
}

/**
 * Short input-keyed cache (default 60 s) with in-flight dedupe for read-only lookups (dashboard Resolve, Telegram
 * /check and link previews): pasting the same link twice, or several members checking the same drop, costs one
 * resolution (~10–15 RPC reads + OpenSea calls) instead of one each. Simulate / mint always call refresh().
 */
const RESOLVE_TTL_MS = 60_000;
const byInput = new Map<string, { at: number; p: Promise<ResolvedTarget> }>();
export function resolveCached(input: string, chain?: string, ttlMs = RESOLVE_TTL_MS): Promise<ResolvedTarget> {
  const k = `${(chain ?? "").toLowerCase()}|${input.trim().toLowerCase()}`;
  const hit = byInput.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = resolveTarget({ input, chain }).then(remember);
  byInput.set(k, { at: Date.now(), p });
  p.catch(() => byInput.delete(k));
  if (byInput.size > 500) for (const [key, v] of byInput) if (Date.now() - v.at > ttlMs) byInput.delete(key);
  return p;
}
