// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NFT holdings via indexers (no per-token RPC scanning).
 *  - Primary: Alchemy NFT API v3 getNFTsForOwner, same API key as the Alchemy RPC URLs (RPC_<CHAIN>), so no new env var.
 *    Covers ethereum, base, polygon, arbitrum, bnb, unichain, robinhood, arc (verified 2026-10-21). Gives ERC-1155
 *    balances and a spam flag.
 *  - Fallback / Ink: OpenSea account NFTs API (OPENSEA_API_KEY). No ERC-1155 balance there, so quantity is null until
 *    the pre-send balanceOf check.
 */
import { getAddress } from "ethers";
import { CHAINS, type ChainConfig } from "../../config/chains.js";
import { env } from "../../config/env.js";
import type { MetaState } from "./metadata.js";
import { canonUri } from "./uri.js";

export type NftStandard = "erc721" | "erc1155";
export interface NftItem {
  contract: string; // checksummed
  tokenId: string; // decimal
  standard: NftStandard;
  /** ERC-721: "1". ERC-1155: balance from the indexer, or null when the indexer doesn't report it. */
  quantity: string | null;
  name: string | null;
  collection: string | null;
  collectionSlug: string | null;
  image: string | null;
  spam: boolean;
  /** Canonical token URI the indexer built this metadata from (compared with tokenURI() on-chain). */
  tokenUri?: string | null;
  /** Freshness state from the on-chain check (see metadata.ts). */
  meta?: MetaState;
}
export interface ScanResult {
  items: NftItem[];
  source: "alchemy" | "opensea";
  truncated: boolean;
}
export type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

/** Alchemy network slug per chain key; Ink is not served by Alchemy's NFT API ("not enabled for that chain"). */
export const ALCHEMY_NFT_NETWORK: Record<string, string> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  bnb: "bnb-mainnet",
  unichain: "unichain-mainnet",
  robinhood: "robinhood-mainnet",
  arc: "arc-mainnet",
};
export const ALCHEMY_PAGE_SIZE = 100;
export const ALCHEMY_MAX_PAGES = 10; // 1 000 NFTs per wallet per chain
export const OPENSEA_PAGE_SIZE = 200;
export const OPENSEA_MAX_PAGES = 5;

/** Alchemy key: ALCHEMY_API_KEY, else taken from any configured Alchemy RPC URL (…g.alchemy.com/v2/<key>). */
export function alchemyKey(e: NodeJS.ProcessEnv = process.env): string | null {
  const direct = (e.ALCHEMY_API_KEY ?? "").trim();
  if (/^[A-Za-z0-9_-]{8,}$/.test(direct)) return direct;
  for (const c of CHAINS) {
    const K = c.key.toUpperCase();
    for (const v of [e[`RPC_URLS_${K}`], e[`RPC_URL_${K}`], e[`RPC_${K}`]]) {
      const m = /\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]{8,})/.exec(v ?? "");
      if (m) return m[1];
    }
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
const httpsOnly = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);
function decId(v: unknown): string | null {
  try {
    const s = String(v ?? "").trim();
    if (!s) return null;
    return BigInt(s).toString();
  } catch {
    return null;
  }
}
function addr(v: unknown): string | null {
  try {
    return getAddress(String(v).toLowerCase());
  } catch {
    return null;
  }
}

/** Normalize one Alchemy v3 ownedNfts entry (pure, unit-tested). */
export function fromAlchemy(n: any): NftItem | null {
  const contract = addr(n?.contract?.address);
  const tokenId = decId(n?.tokenId);
  const t = String(n?.tokenType ?? n?.contract?.tokenType ?? "").toUpperCase();
  const standard: NftStandard | null = t === "ERC721" ? "erc721" : t === "ERC1155" ? "erc1155" : null;
  if (!contract || tokenId === null || !standard) return null;
  const bal = decId(n?.balance);
  const os = n?.contract?.openSeaMetadata ?? {};
  return {
    contract,
    tokenId,
    standard,
    quantity: standard === "erc721" ? "1" : bal && bal !== "0" ? bal : null,
    name: str(n?.name) ?? str(n?.raw?.metadata?.name),
    collection: str(os.collectionName) ?? str(n?.collection?.name) ?? str(n?.contract?.name),
    collectionSlug: str(os.collectionSlug) ?? str(n?.collection?.slug),
    image: httpsOnly(str(n?.image?.thumbnailUrl) ?? str(n?.image?.cachedUrl) ?? str(n?.image?.pngUrl) ?? str(n?.image?.originalUrl)),
    spam: Boolean(n?.contract?.isSpam),
    tokenUri: canonUri(n?.tokenUri ?? n?.raw?.tokenUri),
  };
}

/** Normalize one OpenSea /account/{address}/nfts entry (pure, unit-tested). */
export function fromOpenSea(n: any): NftItem | null {
  const contract = addr(n?.contract);
  const tokenId = decId(n?.identifier);
  const t = String(n?.token_standard ?? "").toLowerCase();
  const standard: NftStandard | null = t === "erc721" ? "erc721" : t === "erc1155" ? "erc1155" : null;
  if (!contract || tokenId === null || !standard) return null;
  return {
    contract,
    tokenId,
    standard,
    quantity: standard === "erc721" ? "1" : null,
    name: str(n?.name),
    collection: str(n?.collection_name) ?? str(n?.collection),
    collectionSlug: str(n?.collection),
    image: httpsOnly(str(n?.display_image_url) ?? str(n?.image_url)),
    spam: Boolean(n?.is_disabled),
    tokenUri: canonUri(n?.metadata_url),
  };
}

async function getJson(f: Fetch, url: string, headers: Record<string, string>, label: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await f(url, { headers, signal: ctrl.signal });
      if (r.status === 429 && attempt < 2) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        continue;
      }
      const j = await r.json().catch(() => null);
      if (!r.ok)
        throw new Error(`${label} HTTP ${r.status}: ${String(j?.error?.message ?? j?.message ?? j?.errors?.[0] ?? "").slice(0, 140)}`);
      return j;
    } finally {
      clearTimeout(t);
    }
  }
}

export async function scanAlchemy(chain: ChainConfig, owner: string, f: Fetch, key = alchemyKey()): Promise<ScanResult> {
  const net = ALCHEMY_NFT_NETWORK[chain.key];
  if (!net || !key) throw new Error(`Alchemy NFT API not available for ${chain.name}`);
  const items: NftItem[] = [];
  let pageKey: string | null = null;
  for (let page = 0; page < ALCHEMY_MAX_PAGES; page++) {
    const q = new URLSearchParams({ owner, pageSize: String(ALCHEMY_PAGE_SIZE), withMetadata: "true" });
    if (pageKey) q.set("pageKey", pageKey);
    const j = await getJson(
      f,
      `https://${net}.g.alchemy.com/nft/v3/${key}/getNFTsForOwner?${q}`,
      { accept: "application/json" },
      "Alchemy",
    );
    for (const n of j?.ownedNfts ?? []) {
      const it = fromAlchemy(n);
      if (it) items.push(it);
    }
    pageKey = typeof j?.pageKey === "string" && j.pageKey ? j.pageKey : null;
    if (!pageKey) return { items, source: "alchemy", truncated: false };
  }
  return { items, source: "alchemy", truncated: true };
}

export async function scanOpenSea(chain: ChainConfig, owner: string, f: Fetch, key = env.openseaApiKey): Promise<ScanResult> {
  if (!key) throw new Error("OPENSEA_API_KEY is not set");
  const items: NftItem[] = [];
  let next: string | null = null;
  for (let page = 0; page < OPENSEA_MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: String(OPENSEA_PAGE_SIZE) });
    if (next) q.set("next", next);
    const j = await getJson(
      f,
      `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chain.openseaChain)}/account/${owner}/nfts?${q}`,
      { accept: "application/json", "x-api-key": key },
      "OpenSea",
    );
    for (const n of j?.nfts ?? []) {
      const it = fromOpenSea(n);
      if (it) items.push(it);
    }
    next = typeof j?.next === "string" && j.next ? j.next : null;
    if (!next) return { items, source: "opensea", truncated: false };
  }
  return { items, source: "opensea", truncated: true };
}

/** Holdings of one wallet on one chain: Alchemy where supported, OpenSea otherwise or when Alchemy fails. */
export async function scanHoldings(chain: ChainConfig, owner: string, f: Fetch = globalThis.fetch as any): Promise<ScanResult> {
  const order: ("alchemy" | "opensea")[] = ALCHEMY_NFT_NETWORK[chain.key] && alchemyKey() ? ["alchemy", "opensea"] : ["opensea"];
  let lastErr: unknown = null;
  for (const src of order) {
    try {
      return src === "alchemy" ? await scanAlchemy(chain, owner, f) : await scanOpenSea(chain, owner, f);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("No NFT indexer configured");
}
