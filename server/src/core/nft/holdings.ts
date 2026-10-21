// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cached NFT holdings (DB) per wallet × chain. Reads never touch an indexer or RPC.
 * Scans: "missing" (wallet/chain pairs never scanned, e.g. first visit or a new wallet), "all" (manual Refresh,
 * 60 s cooldown per user, shared across instances via nft_scan_state) and "continue" (finish a large refresh that
 * ran out of time budget, no extra cooldown). Sends update the cache optimistically (no re-scan).
 */
import { and, eq } from "drizzle-orm";
import { CHAINS, getChain } from "../../config/chains.js";
import { getDb } from "../../db/client.js";
import { nftHoldings, nftScanState } from "../../db/schema.js";
import { listWallets } from "../../users/service.js";
import { redactString } from "../../util/log.js";
import { scanHoldings, type Fetch, type NftItem } from "./indexer.js";

export const REFRESH_COOLDOWN_MS = 60_000;
const SCAN_CONCURRENCY = 4;
const SCAN_BUDGET_MS = 40_000;

export interface HoldingRow {
  walletId: string;
  chain: string;
  address: string;
  items: NftItem[];
  source: string | null;
  error: string | null;
  truncated: boolean;
  scannedAt: string;
}

const rowId = (walletId: string, chain: string) => `${walletId}:${chain}`;
const parseItems = (s: string): NftItem[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export async function loadRows(userId: string): Promise<HoldingRow[]> {
  const rows = await getDb().select().from(nftHoldings).where(eq(nftHoldings.userId, userId));
  return rows.map((r) => ({
    walletId: r.walletId,
    chain: r.chain,
    address: r.address,
    items: parseItems(r.itemsJson),
    source: r.source,
    error: r.error,
    truncated: Boolean(Number(r.truncated)),
    scannedAt: r.scannedAt,
  }));
}

async function lastRefresh(userId: string): Promise<number> {
  const r = (await getDb().select().from(nftScanState).where(eq(nftScanState.userId, userId)).limit(1))[0];
  return r ? Number(r.lastRefreshAt) : 0;
}

/** Everything the NFTs page needs, from the DB only. */
export async function holdingsView(userId: string, now = Date.now()) {
  const [wallets, rows, last] = await Promise.all([listWallets(userId), loadRows(userId), lastRefresh(userId)]);
  const live = new Map(wallets.map((w) => [w.id, w]));
  const have = new Set<string>();
  const items: (NftItem & { walletId: string; chain: string; key: string })[] = [];
  const scans: Omit<HoldingRow, "items">[] = [];
  for (const r of rows) {
    const w = live.get(r.walletId);
    if (!w || w.address.toLowerCase() !== r.address.toLowerCase() || !getChain(r.chain)) continue;
    have.add(rowId(r.walletId, r.chain));
    const { items: its, ...meta } = r;
    scans.push(meta);
    for (const it of its)
      items.push({ ...it, walletId: r.walletId, chain: r.chain, key: `${r.walletId}:${r.chain}:${it.contract}:${it.tokenId}` });
  }
  const missing = wallets.flatMap((w) =>
    CHAINS.filter((c) => !have.has(rowId(w.id, c.key))).map((c) => ({ walletId: w.id, chain: c.key })),
  );
  return {
    wallets: wallets.map((w) => ({ id: w.id, label: w.label, address: w.address })),
    chains: CHAINS.map((c) => ({ key: c.key, name: c.name, nativeSymbol: c.nativeSymbol, explorer: c.explorer })),
    items,
    scans,
    missing: missing.length,
    lastRefreshAt: last ? new Date(last).toISOString() : null,
    cooldownMs: Math.max(0, last + REFRESH_COOLDOWN_MS - now),
  };
}

async function saveRow(
  userId: string,
  walletId: string,
  chain: string,
  address: string,
  patch: Partial<HoldingRow> & { scannedAt: string },
) {
  const id = rowId(walletId, chain);
  const values = {
    id,
    userId,
    walletId,
    chain,
    address,
    itemsJson: JSON.stringify(patch.items ?? []),
    source: patch.source ?? null,
    error: patch.error ?? null,
    truncated: patch.truncated ? 1 : 0,
    scannedAt: patch.scannedAt,
  };
  const set: Record<string, unknown> = { address, scannedAt: values.scannedAt, error: values.error, userId };
  if (patch.items) {
    set.itemsJson = values.itemsJson;
    set.source = values.source;
    set.truncated = values.truncated;
  }
  await getDb().insert(nftHoldings).values(values).onConflictDoUpdate({ target: nftHoldings.id, set });
}

async function mapLimit<T>(xs: T[], n: number, fn: (x: T) => Promise<void>, deadline: number) {
  let i = 0;
  let skipped = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const x = xs[i++];
        if (Date.now() > deadline) {
          skipped++;
          continue;
        }
        await fn(x);
      }
    }),
  );
  return skipped;
}

export type RefreshMode = "missing" | "all" | "continue";

/**
 * Scan via the indexer. Throws 429 with `retryAfterMs` while a manual refresh is cooling down.
 * Returns how many pairs were scanned / failed and how many remain (time budget) so the client can "continue".
 */
export async function refreshHoldings(
  userId: string,
  mode: RefreshMode,
  opts: { fetchImpl?: Fetch; now?: number; budgetMs?: number; scan?: typeof scanHoldings } = {},
) {
  const now = opts.now ?? Date.now();
  const scan = opts.scan ?? scanHoldings;
  const [wallets, rows, last] = await Promise.all([listWallets(userId), loadRows(userId), lastRefresh(userId)]);
  const byId = new Map(rows.map((r) => [rowId(r.walletId, r.chain), r]));
  let since = 0;
  if (mode === "all") {
    const wait = last + REFRESH_COOLDOWN_MS - now;
    if (wait > 0)
      throw Object.assign(new Error(`Holdings were refreshed recently. Try again in ${Math.ceil(wait / 1000)}s.`), {
        statusCode: 429,
        code: "COOLDOWN",
        retryAfterMs: wait,
      });
    await getDb()
      .insert(nftScanState)
      .values({ userId, lastRefreshAt: now })
      .onConflictDoUpdate({ target: nftScanState.userId, set: { lastRefreshAt: now } });
    since = now;
  } else if (mode === "continue") since = last;
  const targets = wallets.flatMap((w) =>
    CHAINS.filter((c) => {
      const r = byId.get(rowId(w.id, c.key));
      if (mode === "missing") return !r || r.address.toLowerCase() !== w.address.toLowerCase();
      return !r || Date.parse(r.scannedAt) < since;
    }).map((c) => ({ w, c })),
  );
  let scanned = 0;
  let failed = 0;
  const remaining = await mapLimit(
    targets,
    SCAN_CONCURRENCY,
    async ({ w, c }) => {
      const at = new Date().toISOString();
      try {
        const r = await scan(c, w.address, opts.fetchImpl ?? (globalThis.fetch as any));
        await saveRow(userId, w.id, c.key, w.address, {
          items: r.items,
          source: r.source,
          truncated: r.truncated,
          error: null,
          scannedAt: at,
        });
        scanned++;
      } catch (e: any) {
        failed++;
        // Keep the previous items (if any); record the error so the UI can show it.
        await saveRow(userId, w.id, c.key, w.address, {
          error: redactString(String(e?.message ?? e)).slice(0, 160),
          scannedAt: at,
          ...(byId.has(rowId(w.id, c.key)) ? {} : { items: [] }),
        });
      }
    },
    now + (opts.budgetMs ?? SCAN_BUDGET_MS),
  );
  return { mode, scanned, failed, remaining, total: targets.length };
}

/**
 * Optimistic cache update after a broadcast transfer: remove (ERC-721) or decrement (ERC-1155) the token from the
 * source wallet and, when the destination is one of the user's own wallets, add it there.
 */
export async function applyTransferToCache(
  userId: string,
  t: { walletId: string; chain: string; contract: string; tokenId: string; quantity: bigint; destination: string },
) {
  const rows = await loadRows(userId);
  const src = rows.find((r) => r.walletId === t.walletId && r.chain === t.chain);
  if (!src) return;
  const match = (i: NftItem) => i.contract.toLowerCase() === t.contract.toLowerCase() && i.tokenId === t.tokenId;
  const moved = src.items.find(match);
  const items: NftItem[] = [];
  for (const i of src.items) {
    if (!match(i)) items.push(i);
    else if (i.standard === "erc1155" && i.quantity !== null && BigInt(i.quantity) > t.quantity)
      items.push({ ...i, quantity: (BigInt(i.quantity) - t.quantity).toString() });
  }
  const at = new Date().toISOString();
  await getDb()
    .update(nftHoldings)
    .set({ itemsJson: JSON.stringify(items) })
    .where(and(eq(nftHoldings.id, rowId(t.walletId, t.chain)), eq(nftHoldings.userId, userId)));
  const own = (await listWallets(userId)).find((w) => w.address.toLowerCase() === t.destination.toLowerCase());
  const dst = own ? rows.find((r) => r.walletId === own.id && r.chain === t.chain) : null;
  if (own && dst && moved) {
    const existing = dst.items.find(match);
    const next = existing
      ? dst.items.map((i) =>
          match(i) && i.standard === "erc1155" && i.quantity !== null
            ? { ...i, quantity: (BigInt(i.quantity) + t.quantity).toString() }
            : i,
        )
      : [...dst.items, { ...moved, quantity: moved.standard === "erc721" ? "1" : t.quantity.toString() }];
    await getDb()
      .update(nftHoldings)
      .set({ itemsJson: JSON.stringify(next) })
      .where(and(eq(nftHoldings.id, rowId(own.id, t.chain)), eq(nftHoldings.userId, userId)));
  }
  return { at };
}

/** Non-spam NFTs the cache says this wallet holds (used by the wallet-removal check). */
export async function cachedNftCount(userId: string, walletId: string) {
  const rows = (await loadRows(userId)).filter((r) => r.walletId === walletId);
  const byChain = rows
    .map((r) => ({ chain: r.chain, count: r.items.filter((i) => !i.spam).length, scannedAt: r.scannedAt }))
    .filter((x) => x.count > 0);
  return { total: byChain.reduce((s, x) => s + x.count, 0), byChain, scanned: rows.length > 0 };
}
