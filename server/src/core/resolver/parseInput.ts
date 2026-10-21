import { getChain } from "../../config/chains.js";

export interface ParsedInput {
  kind: "address" | "slug";
  value: string; // checksummed-or-lowercase address, or lowercase slug
  chainHint?: string; // our chain key if recognisable from the URL
  tokenId?: string;
  source: "opensea" | "explorer" | "raw" | "url";
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const EXPLORERS: Record<string, string> = {
  "etherscan.io": "ethereum",
  "basescan.org": "base",
  "arbiscan.io": "arbitrum",
  "optimistic.etherscan.io": "optimism",
  "polygonscan.com": "polygon",
};

function chainKey(seg?: string): string | undefined {
  if (!seg) return undefined;
  return getChain(seg)?.key ?? seg.toLowerCase();
}

/** Accepts: OpenSea collection/drop/item URLs, bare slug, 0x address, explorer URLs, any URL containing an address. */
export function parseInput(raw: string): ParsedInput {
  const input = (raw ?? "").trim().replace(/\/+$/, "");
  if (!input) throw new Error("Empty input — paste an OpenSea link, collection slug or contract address");
  if (ADDR.test(input)) return { kind: "address", value: input, source: "raw" };

  const looksUrl = /^https?:\/\//i.test(input) || /^[\w.-]+\.[a-z]{2,}\//i.test(input);
  if (looksUrl) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error(`Could not parse URL "${input}"`); }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const segs = url.pathname.split("/").map((s) => decodeURIComponent(s).trim()).filter(Boolean);

    if (host.endsWith("opensea.io")) {
      const i = segs.findIndex((s) => s === "assets" || s === "item");
      if (i >= 0) {
        const rest = segs.slice(i + 1);
        const a = rest.findIndex((s) => ADDR.test(s));
        if (a >= 0) return { kind: "address", value: rest[a], chainHint: a > 0 ? chainKey(rest[a - 1]) : undefined, tokenId: rest[a + 1], source: "opensea" };
      }
      const c = segs.indexOf("collection");
      if (c >= 0 && segs[c + 1]) {
        return { kind: "slug", value: segs[c + 1].toLowerCase(), chainHint: c > 0 ? chainKey(segs[c - 1]) : undefined, source: "opensea" };
      }
      const addr = segs.find((s) => ADDR.test(s));
      if (addr) return { kind: "address", value: addr, source: "opensea" };
      throw new Error("OpenSea URL has no collection slug or contract address — paste the collection or item link");
    }

    const explorerChain = Object.entries(EXPLORERS).find(([h]) => host === h || host.endsWith("." + h))?.[1];
    const addr = segs.find((s) => ADDR.test(s)) ?? input.match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (addr) return { kind: "address", value: addr, chainHint: explorerChain, source: explorerChain ? "explorer" : "url" };
    throw new Error(`No contract address found in "${input}"`);
  }

  const embedded = input.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (embedded) return { kind: "address", value: embedded, source: "raw" };
  if (/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(input)) return { kind: "slug", value: input.toLowerCase(), source: "raw" };
  throw new Error(`Could not read "${input}" as an OpenSea link, slug, or contract address`);
}
