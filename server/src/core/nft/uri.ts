// SPDX-License-Identifier: AGPL-3.0-only
/** Token URI helpers shared by the indexer normalizers and the metadata freshness check (pure). */
import { createHash } from "node:crypto";

/** Public IPFS gateways that still serve JSON to servers (ipfs.io / dweb.link switched to service-worker only). */
export const IPFS_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs2.seadn.io/ipfs/"];

/** Canonical form for comparing token URIs: ipfs://CID/path, ar://id, else the trimmed URL; long values hashed. */
export function canonUri(u: unknown): string | null {
  if (typeof u !== "string") return null;
  let s = u.trim();
  if (!s) return null;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(s) ?? /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(s);
  if (ipfs) s = `ipfs://${ipfs[1]}`;
  else {
    const ar = /^ar:\/\/(.+)$/i.exec(s) ?? /^https?:\/\/(?:www\.)?arweave\.net\/(.+)$/i.exec(s);
    if (ar) s = `ar://${ar[1]}`;
  }
  s = s.replace(/\?$/, "");
  return s.length > 240 ? `sha256:${createHash("sha256").update(s).digest("hex")}` : s;
}

/** ERC-1155 `{id}` substitution (lower-case, 64 hex chars, per EIP-1155). */
export const expandId = (uri: string, tokenId: string) =>
  uri.includes("{id}") ? uri.replaceAll("{id}", BigInt(tokenId).toString(16).padStart(64, "0")) : uri;

/** Same token URI? Accepts the decimal `{id}` form some indexers use for ERC-1155. */
export function sameUri(indexer: string | null | undefined, onchainRaw: string, tokenId: string): boolean {
  const a = indexer ?? null;
  if (!a) return false;
  const variants = [expandId(onchainRaw, tokenId), onchainRaw.replaceAll("{id}", BigInt(tokenId).toString()), onchainRaw];
  return variants.some((v) => canonUri(v) === a);
}

export const toHttp = (u: string): string[] => {
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u);
  if (ipfs) return IPFS_GATEWAYS.map((g) => g + ipfs[1]);
  const ar = /^ar:\/\/(.+)$/i.exec(u);
  if (ar) return [`https://arweave.net/${ar[1]}`];
  return /^https:\/\//i.test(u) ? [u] : [];
};
