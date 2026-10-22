// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Metadata freshness for cached NFT holdings.
 *
 * Why: NFT indexers cache token metadata. After a collection reveals (the contract's baseURI changes, or a mutable
 * metadata server starts returning the revealed JSON), Alchemy keeps serving the pre-reveal name/image for months
 * (verified 2026-10-22: Drip Dragons, OG Bros, Boonish, Dinolong, Project Lobster and Feline Brokers all had an
 * Alchemy `tokenUri` that no longer matched the contract's tokenURI()). Transfer webhooks never fire on a reveal.
 *
 * How (cheap): read tokenURI()/uri() on-chain for the scanned tokens in ONE Multicall3 eth_call per chunk and
 * compare with the URI the indexer used. Only tokens whose URI changed (or that still look unrevealed and use a
 * mutable https URI) are re-resolved: OpenSea's single-NFT endpoint first (fresh, CDN image), else the metadata
 * JSON from the on-chain URI itself. Results are remembered per token (`meta`), so later scans reuse them without
 * new API calls while the on-chain URI stays the same. Indexer refreshes are requested for fixed tokens so the
 * indexer converges too.
 */
import { Interface } from "ethers";
import type { ChainConfig } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { getPool } from "../rpc/pool.js";
import { aggregate, type McResult } from "../rpc/multicall.js";
import { ALCHEMY_NFT_NETWORK, alchemyKey, type Fetch, type NftItem } from "./indexer.js";
import { IPFS_GATEWAYS, canonUri, expandId, sameUri, toHttp } from "./uri.js";

export { IPFS_GATEWAYS, canonUri, expandId, sameUri, toHttp };

/** Re-check placeholder-looking tokens in the background at most this often (housekeeping). */
export const META_RECHECK_MS = 60 * 60_000;
/** tokenURI() calls per Multicall3 eth_call (on-chain SVG renderers can be gas-heavy). */
export const TOKEN_URI_CHUNK = 50;
/** At most this many tokens are re-resolved per wallet × chain per pass (rate-limit friendly). */
export const MAX_RESOLVE = 30;
const RESOLVE_CONCURRENCY = 3;
/** Alchemy refreshNftMetadata is only offered on these networks; elsewhere getNFTMetadata?refreshCache=true. */
const ALCHEMY_REFRESH_ENDPOINT = new Set(["ethereum", "polygon", "arbitrum", "base"]);

export interface MetaState {
  /** Canonical on-chain token URI at the last check (hashed when long, e.g. data: URIs). */
  uri: string | null;
  /** Epoch ms of the last on-chain check. */
  at: number;
  /** True when name/image were replaced with freshly resolved metadata (the indexer was stale). */
  fixed?: boolean;
  /** Where the fixed metadata came from. */
  via?: "opensea" | "tokenuri";
}

export const PLACEHOLDER_RE =
  /\b(pre[\s_-]?reveal(ed)?|unrevealed|not[\s_-]revealed|revealing|to be revealed|blind[\s_-]?box|mystery[\s_-]?box|placeholder|coming soon)\b/i;

/** Heuristic: still shows unrevealed metadata (name says so, or the whole collection shares one image / has none). */
export function looksUnrevealed(item: NftItem, siblings: NftItem[] = []): boolean {
  if (item.spam) return false;
  if (PLACEHOLDER_RE.test(item.name ?? "")) return true;
  const same = siblings.filter((s) => s.contract === item.contract && s.tokenId !== item.tokenId);
  if (!item.name && !item.image) return true;
  return Boolean(item.image && same.length > 0 && same.every((s) => s.image === item.image) && item.standard === "erc721");
}

const uriIface = new Interface([
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function uri(uint256 id) view returns (string)",
]);

/** Looks unrevealed AND has an on-chain token URI that can still change (worth a background re-check). */
export const isPendingReveal = (item: NftItem, siblings: NftItem[]) => Boolean(item.meta?.uri) && looksUnrevealed(item, siblings);

export type TokenUriReader = (chain: ChainConfig, items: NftItem[]) => Promise<(string | null)[]>;

/** tokenURI()/uri() for many tokens: one Multicall3 eth_call per chunk; failures yield null (never throw). */
export const readTokenUris: TokenUriReader = async (chain, items) => {
  const out: (string | null)[] = items.map(() => null);
  if (!items.length) return out;
  const pool = getPool(chain);
  for (let i = 0; i < items.length; i += TOKEN_URI_CHUNK) {
    const chunk = items.slice(i, i + TOKEN_URI_CHUNK);
    let rows: McResult[];
    try {
      rows = await aggregate(
        pool,
        chunk.map((it) => ({
          target: it.contract,
          data: uriIface.encodeFunctionData(it.standard === "erc1155" ? "uri" : "tokenURI", [BigInt(it.tokenId)]),
        })),
        "tokenURI",
      );
    } catch {
      continue;
    }
    rows.forEach((r, k) => {
      if (!r.success || r.returnData === "0x") return;
      try {
        const fn = chunk[k].standard === "erc1155" ? "uri" : "tokenURI";
        const s = String(uriIface.decodeFunctionResult(fn, r.returnData)[0] ?? "").trim();
        out[i + k] = s || null;
      } catch {
        /* non-string return */
      }
    });
  }
  return out;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

async function getJson(f: Fetch, url: string, headers: Record<string, string> = {}, ms = 8_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await f(url, { headers: { accept: "application/json", ...headers }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Parse metadata straight from a token URI (data: JSON, https, ipfs or arweave via public gateways). */
export async function metadataFromUri(uri: string, f: Fetch): Promise<{ name: string | null; image: string | null } | null> {
  let j: any = null;
  if (/^data:application\/json/i.test(uri)) {
    try {
      const body = uri.slice(uri.indexOf(",") + 1);
      j = JSON.parse(
        /;base64,/i.test(uri.slice(0, uri.indexOf(",") + 1)) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body),
      );
    } catch {
      return null;
    }
  } else {
    for (const u of toHttp(uri)) {
      j = await getJson(f, u);
      if (j && typeof j === "object") break;
    }
  }
  if (!j || typeof j !== "object") return null;
  const img = str(j.image) ?? str(j.image_url);
  const image = img ? (/^https:\/\//i.test(img) ? img : (toHttp(img)[0] ?? null)) : null;
  return { name: str(j.name), image };
}

/** OpenSea single NFT (fresh on request). Trusted only when it was built from the same on-chain URI. */
export async function metadataFromOpenSea(
  chain: ChainConfig,
  item: NftItem,
  onchainRaw: string,
  f: Fetch,
  key = env.openseaApiKey,
): Promise<{ name: string | null; image: string | null } | null> {
  if (!key) return null;
  const j = await getJson(
    f,
    `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chain.openseaChain)}/contract/${item.contract}/nfts/${item.tokenId}`,
    { "x-api-key": key },
  );
  const n = j?.nft;
  if (!n) return null;
  if (!sameUri(canonUri(n.metadata_url), onchainRaw, item.tokenId)) return null;
  const image = str(n.display_image_url) ?? str(n.image_url);
  return { name: str(n.name), image: image && /^https:\/\//i.test(image) ? image : null };
}

/** Ask the indexer to refresh its cached metadata (best effort, bounded). */
async function requestIndexerRefresh(chain: ChainConfig, items: NftItem[], f: Fetch) {
  const net = ALCHEMY_NFT_NETWORK[chain.key];
  const key = alchemyKey();
  if (!net || !key || !items.length) return;
  await Promise.allSettled(
    items.slice(0, 10).map(async (it) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      try {
        if (ALCHEMY_REFRESH_ENDPOINT.has(chain.key))
          await (f as any)(`https://${net}.g.alchemy.com/nft/v3/${key}/refreshNftMetadata`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ contractAddress: it.contract, tokenId: it.tokenId }),
            signal: ctrl.signal,
          });
        else
          await f(
            `https://${net}.g.alchemy.com/nft/v3/${key}/getNFTMetadata?contractAddress=${it.contract}&tokenId=${it.tokenId}&refreshCache=true`,
            { headers: { accept: "application/json" }, signal: ctrl.signal },
          );
      } finally {
        clearTimeout(t);
      }
    }),
  );
}

export interface VerifyOptions {
  fetchImpl?: Fetch;
  now?: number;
  readUris?: TokenUriReader;
  /** Re-resolve placeholder-looking tokens on a mutable (https) URI even when the URI is unchanged. */
  recheckPlaceholders?: boolean;
  /** Only check these items (housekeeping passes placeholders only); others are returned untouched. */
  only?: (it: NftItem) => boolean;
}

export interface VerifyResult {
  items: NftItem[];
  checked: number;
  fixed: number;
  /** Tokens that still look unrevealed (housekeeping re-checks them later). */
  placeholders: number;
}

const mutable = (raw: string) => /^https?:\/\//i.test(raw) && !/\/ipfs\//i.test(raw);

/**
 * Compare indexer metadata with the chain and repair stale entries. Never throws; on any RPC failure the indexer's
 * items are returned unchanged. `prev` = the items cached before this scan (reuses earlier fixes).
 */
export async function verifyMetadata(
  chain: ChainConfig,
  items: NftItem[],
  prev: NftItem[] = [],
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const f = opts.fetchImpl ?? (globalThis.fetch as any as Fetch);
  const now = opts.now ?? Date.now();
  const prevBy = new Map(prev.map((p) => [`${p.contract.toLowerCase()}:${p.tokenId}`, p]));
  const targets = items.filter((it) => !it.spam && (!opts.only || opts.only(it)));
  let uris: (string | null)[];
  try {
    uris = await (opts.readUris ?? readTokenUris)(chain, targets);
  } catch {
    return { items, checked: 0, fixed: 0, placeholders: items.filter((i) => isPendingReveal(i, items)).length };
  }
  const next = new Map<NftItem, NftItem>();
  const toResolve: { it: NftItem; raw: string }[] = [];
  targets.forEach((it, k) => {
    const raw = uris[k];
    if (!raw) return; // unknown: keep the indexer's data
    const canon = canonUri(expandId(raw, it.tokenId));
    const p = prevBy.get(`${it.contract.toLowerCase()}:${it.tokenId}`);
    const indexerStale = Boolean(it.tokenUri) && !sameUri(it.tokenUri, raw, it.tokenId);
    // Earlier fix for the same on-chain URI → reuse it (no API call).
    if (p?.meta?.fixed && p.meta.uri === canon && (indexerStale || !it.tokenUri || looksUnrevealed(it, items))) {
      next.set(it, { ...it, name: p.name, image: p.image, meta: { ...p.meta, at: now } });
      return;
    }
    const placeholder = looksUnrevealed(it, items);
    const urlChanged = Boolean(p?.meta && p.meta.uri !== canon);
    if (indexerStale || (placeholder && (urlChanged || (opts.recheckPlaceholders && mutable(raw)) || (!it.tokenUri && !p?.meta))))
      toResolve.push({ it, raw });
    else next.set(it, { ...it, meta: { uri: canon, at: now } });
  });

  let fixed = 0;
  const refreshed: NftItem[] = [];
  const queue = toResolve.slice(0, MAX_RESOLVE);
  let qi = 0;
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
      while (qi < queue.length) {
        const { it, raw } = queue[qi++];
        const canon = canonUri(expandId(raw, it.tokenId));
        const uri = expandId(raw, it.tokenId);
        const m =
          (await metadataFromOpenSea(chain, it, raw, f).then((x) => (x ? { ...x, via: "opensea" as const } : null))) ??
          (await metadataFromUri(uri, f).then((x) => (x ? { ...x, via: "tokenuri" as const } : null)));
        if (m && (m.name || m.image)) {
          const changed = m.name !== it.name || (m.image && m.image !== it.image);
          next.set(it, {
            ...it,
            name: m.name ?? it.name,
            image: m.image ?? it.image,
            meta: { uri: canon, at: now, fixed: true, via: m.via },
          });
          if (changed) {
            fixed++;
            refreshed.push(it);
          }
        } else next.set(it, it); // couldn't resolve now: keep as is, try again next pass (no meta stamp)
      }
    }),
  );
  if (refreshed.length) await requestIndexerRefresh(chain, refreshed, f).catch(() => {});
  const out = items.map((it) => next.get(it) ?? it);
  return { items: out, checked: targets.length, fixed, placeholders: out.filter((i) => isPendingReveal(i, out)).length };
}
