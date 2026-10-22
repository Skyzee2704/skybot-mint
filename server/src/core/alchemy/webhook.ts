// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/webhooks/alchemy — Address Activity deliveries.
 *  1. Verify X-Alchemy-Signature = hex(HMAC-SHA256(signingKey, rawBody)) with the signing key of THAT webhook id
 *     (per network, stored encrypted by the sync). Unknown webhook or bad signature → 401, nothing else happens.
 *  2. Map activity to SkyBOT wallets: native/ERC-20 → record activity + drop the balance cache (all instances see
 *     wallet_activity, so their cached balance is treated as stale); ERC-721/1155 → remove outgoing ERC-721 from the
 *     holdings cache immediately and queue a debounced indexer re-scan of only that wallet × chain.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { getAddress } from "ethers";
import { getDb } from "../../db/client.js";
import { walletActivity, wallets } from "../../db/schema.js";
import { invalidateBalances } from "../../util/balanceCache.js";
import { log, redactString } from "../../util/log.js";
import { removeErc721FromCache } from "../nft/holdings.js";
import { enqueueRescan, processRescanQueue, RESCAN_DELAY_MS } from "../nft/rescan.js";
import { chainForNetwork } from "./networks.js";
import { signingKeyFor } from "./sync.js";

export function signBody(raw: string, signingKey: string) {
  return createHmac("sha256", signingKey).update(raw, "utf8").digest("hex");
}

/** Constant-time check of the X-Alchemy-Signature header (hex HMAC-SHA256 of the raw body). */
export function verifyAlchemySignature(raw: string, signature: string | null | undefined, signingKey: string | null | undefined) {
  if (!signature || !signingKey || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const a = Buffer.from(signBody(raw, signingKey), "hex");
  const b = Buffer.from(signature.trim().toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Kind = "native" | "erc20" | "nft";
export interface Touch {
  chain: string;
  address: string; // lower-case
  kinds: Set<Kind>;
  /** ERC-721 tokens that LEFT this address (safe to drop from the cache right away). */
  erc721Out: { contract: string; tokenId: string }[];
}

const lower = (a: unknown) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null);
const dec = (v: unknown) => {
  try {
    return v === null || v === undefined || v === "" ? null : BigInt(String(v)).toString();
  } catch {
    return null;
  }
};

/** Pure: Address Activity payload → per chain × address touches. Unknown networks / malformed entries are ignored. */
export function parseAddressActivity(payload: any): { webhookId: string | null; chain: string | null; touches: Touch[] } {
  const webhookId = typeof payload?.webhookId === "string" ? payload.webhookId : null;
  if (payload?.type !== "ADDRESS_ACTIVITY") return { webhookId, chain: null, touches: [] };
  const chain = chainForNetwork(String(payload?.event?.network ?? ""));
  if (!chain) return { webhookId, chain: null, touches: [] };
  const m = new Map<string, Touch>();
  const touch = (address: string) => {
    let t = m.get(address);
    if (!t) m.set(address, (t = { chain, address, kinds: new Set(), erc721Out: [] }));
    return t;
  };
  for (const a of Array.isArray(payload?.event?.activity) ? payload.event.activity : []) {
    const cat = String(a?.category ?? "").toLowerCase();
    const from = lower(a?.fromAddress);
    const to = lower(a?.toAddress);
    const contract = lower(a?.rawContract?.address ?? a?.log?.address);
    const tokenId721 = dec(a?.erc721TokenId);
    const is1155 = cat === "erc1155" || (Array.isArray(a?.erc1155Metadata) && a.erc1155Metadata.length > 0);
    const is721 = cat === "erc721" || (cat === "token" && tokenId721 !== null);
    const kind: Kind | null =
      cat === "external" || cat === "internal" ? "native" : is721 || is1155 ? "nft" : cat === "erc20" || cat === "token" ? "erc20" : null;
    if (!kind) continue;
    for (const addr of [from, to]) if (addr && addr !== "0x0000000000000000000000000000000000000000") touch(addr).kinds.add(kind);
    if (is721 && from && contract && tokenId721 !== null && a?.log?.removed !== true)
      touch(from).erc721Out.push({ contract: getAddress(contract), tokenId: tokenId721 });
  }
  return { webhookId, chain, touches: [...m.values()] };
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  /** Work to run after the response (Next.js after()): the debounced holdings re-scan. */
  followUp?: () => Promise<void>;
}

/** Apply touches: activity rows, balance cache, holdings cache, re-scan queue. Exported for tests. */
export async function applyTouches(touches: Touch[], now = Date.now()) {
  if (!touches.length) return { wallets: 0, balances: 0, rescans: 0, removed: 0 };
  const addrs = [...new Set(touches.map((t) => t.address))];
  const mine = await getDb()
    .select({ id: wallets.id, userId: wallets.userId, address: wallets.address })
    .from(wallets)
    .where(and(inArray(sql`lower(${wallets.address})`, addrs), isNull(wallets.removedAt)));
  if (!mine.length) return { wallets: 0, balances: 0, rescans: 0, removed: 0 };
  let balances = 0;
  let removed = 0;
  const rescans: { userId: string; walletId: string; chain: string; address: string }[] = [];
  for (const t of touches) {
    const ws = mine.filter((w) => w.address.toLowerCase() === t.address);
    if (!ws.length) continue;
    const id = `${t.chain}:${t.address}`;
    const kinds = [...t.kinds].sort().join(",");
    await getDb()
      .insert(walletActivity)
      .values({ id, chain: t.chain, address: t.address, at: now, kinds })
      .onConflictDoUpdate({ target: walletActivity.id, set: { at: now, kinds } });
    // Every transfer the wallet signs costs gas, and native/NFT moves change balances: always drop the cache.
    invalidateBalances(t.chain, [t.address]);
    balances++;
    if (t.kinds.has("nft")) {
      for (const w of ws) {
        removed += await removeErc721FromCache(w.userId, w.id, t.chain, t.erc721Out).catch(() => 0);
        rescans.push({ userId: w.userId, walletId: w.id, chain: t.chain, address: w.address });
      }
    }
  }
  if (rescans.length) await enqueueRescan(rescans, now);
  return { wallets: new Set(mine.map((w) => w.id)).size, balances, rescans: rescans.length, removed };
}

export async function handleAlchemyWebhook(raw: string, signature: string | null): Promise<WebhookResult> {
  if (raw.length > 5_000_000) return { status: 413, body: { error: "too large" } };
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  const webhookId = typeof payload?.webhookId === "string" ? payload.webhookId.slice(0, 100) : null;
  const key = webhookId ? await signingKeyFor(webhookId) : null;
  if (!verifyAlchemySignature(raw, signature, key)) {
    // Unverified (dashboard "Test Webhook" before the webhook exists, unknown webhook, or forged): acknowledge with
    // 200 so Alchemy's test passes, but do NOTHING with the payload.
    log.warn("alchemy webhook ignored (unverified)", { webhookId, knownKey: Boolean(key) });
    return { status: 200, body: { ok: true, ignored: "unverified" } };
  }
  const parsed = parseAddressActivity(payload);
  try {
    const r = await applyTouches(parsed.touches);
    return {
      status: 200,
      body: { ok: true, chain: parsed.chain, ...r },
      followUp: r.rescans
        ? async () => {
            await new Promise((res) => setTimeout(res, RESCAN_DELAY_MS + 1_000));
            await processRescanQueue({ limit: 20 }).catch((e) => log.warn("nft rescan", String(e?.message ?? e).slice(0, 160)));
          }
        : undefined,
    };
  } catch (e: any) {
    // 500 → Alchemy retries with backoff; nothing partial is harmful (all steps are idempotent).
    log.warn("alchemy webhook apply failed", redactString(String(e?.message ?? e)).slice(0, 160));
    return { status: 500, body: { error: "temporarily unavailable" } };
  }
}
