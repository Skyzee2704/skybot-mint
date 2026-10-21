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
