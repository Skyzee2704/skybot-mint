// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Debounced, cross-instance NFT re-scan queue (DB). Webhooks enqueue wallet × chain pairs with dueAt = now + delay;
 * a burst of events keeps pushing dueAt forward, so the indexer is called once per burst. Rows are claimed with a
 * DELETE … RETURNING (only one instance processes a row). Each burst gets a second pass a minute later because the
 * NFT indexer can lag the chain by a few seconds.
 */
import { and, inArray, lte } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { nftRescanQueue } from "../../db/schema.js";
import { log } from "../../util/log.js";
import { rescanPair } from "./holdings.js";

export const RESCAN_DELAY_MS = 15_000;
export const SECOND_PASS_MS = 60_000;

export async function enqueueRescan(pairs: { userId: string; walletId: string; chain: string; address: string }[], now = Date.now()) {
  for (const p of pairs) {
    const id = `${p.walletId}:${p.chain}`;
    const dueAt = now + RESCAN_DELAY_MS;
    await getDb()
      .insert(nftRescanQueue)
      .values({ id, userId: p.userId, walletId: p.walletId, chain: p.chain, address: p.address, dueAt, pass: 1 })
      .onConflictDoUpdate({ target: nftRescanQueue.id, set: { dueAt, pass: 1 } });
  }
}

/** Process due rows (at most `limit`). Returns counts. */
export async function processRescanQueue(
  opts: { now?: number; limit?: number; rescan?: typeof rescanPair } = {},
): Promise<{ scanned: number; failed: number; skipped: number }> {
  const now = opts.now ?? Date.now();
  const out = { scanned: 0, failed: 0, skipped: 0 };
  const due = await getDb()
    .select()
    .from(nftRescanQueue)
    .where(lte(nftRescanQueue.dueAt, now))
    .limit(opts.limit ?? 20);
  if (!due.length) return out;
  // Claim: delete only rows still due (an event that arrived meanwhile pushed dueAt forward → not claimed).
  const claimed = await getDb()
    .delete(nftRescanQueue)
    .where(
      and(
        inArray(
          nftRescanQueue.id,
          due.map((d) => d.id),
        ),
        lte(nftRescanQueue.dueAt, now),
      ),
    )
    .returning();
  for (const r of claimed) {
    try {
      const res = await (opts.rescan ?? rescanPair)(r.userId, r.walletId, r.chain);
      out[res]++;
    } catch (e: any) {
      out.failed++;
      log.warn("nft rescan failed", String(e?.message ?? e).slice(0, 160));
    }
    if (Number(r.pass) < 2) {
      await getDb()
        .insert(nftRescanQueue)
        .values({ ...r, dueAt: now + SECOND_PASS_MS, pass: 2 })
        .onConflictDoNothing()
        .catch(() => {});
    }
  }
  return out;
}

/** Pending re-scans for a user (the NFTs page shows "updating" and revalidates shortly). */
export async function pendingRescans(userId: string) {
  const { eq } = await import("drizzle-orm");
  const rows = (
    await getDb()
      .select({ dueAt: nftRescanQueue.dueAt, pass: nftRescanQueue.pass })
      .from(nftRescanQueue)
      .where(eq(nftRescanQueue.userId, userId))
  ).filter((r) => Number(r.pass) < 2);
  return rows.length ? Math.min(...rows.map((r) => Number(r.dueAt))) : null;
}
