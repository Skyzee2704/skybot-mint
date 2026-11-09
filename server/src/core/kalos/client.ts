// SPDX-License-Identifier: AGPL-3.0-only
import { KALOS_API, type KalosDrop, type KalosEligibility } from "./types.js";

type FetchFn = typeof fetch;

let dropsCache: { at: number; drops: KalosDrop[] } | null = null;
const DROPS_TTL_MS = 30_000;

async function getJson(url: string, f: FetchFn, timeoutMs: number): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`Kalos HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Kalos HTTP ${res.status}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw last instanceof Error ? last : new Error("Kalos request failed");
}

export async function fetchKalosDrops(f: FetchFn = fetch, opts: { fresh?: boolean } = {}): Promise<KalosDrop[]> {
  if (!opts.fresh && dropsCache && Date.now() - dropsCache.at < DROPS_TTL_MS) return dropsCache.drops;
  const j = await getJson(`${KALOS_API}/v2/launch/drops`, f, 12_000);
  const drops = Array.isArray(j?.drops) ? (j.drops as KalosDrop[]) : [];
  dropsCache = { at: Date.now(), drops };
  return drops;
}

export function resetKalosDropsCache() {
  dropsCache = null;
}

export async function fetchKalosEligibility(slug: string, wallet: string, f: FetchFn = fetch): Promise<KalosEligibility> {
  const j = await getJson(`${KALOS_API}/v2/launch/drops/${encodeURIComponent(slug)}/eligibility/${encodeURIComponent(wallet)}`, f, 10_000);
  return {
    minter: String(j?.minter ?? wallet),
    root: j?.root,
    published: j?.published,
    rootIsKalos: j?.rootIsKalos,
    entries: Array.isArray(j?.entries) ? j.entries : [],
  };
}

/** Bounded parallelism for wallet × drop eligibility calls. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function findKalosDrop(drops: KalosDrop[], q: { slug?: string | null; address?: string | null }): KalosDrop | null {
  const slug = q.slug?.trim().toLowerCase();
  const addr = q.address?.toLowerCase();
  return drops.find((d) => (slug && d.slug.toLowerCase() === slug) || (addr && d.address.toLowerCase() === addr)) ?? null;
}
