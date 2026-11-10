// SPDX-License-Identifier: AGPL-3.0-only
import { getAddress } from "ethers";
import { requireChain } from "../../config/chains.js";
import type { ResolvedTarget, Stage } from "../resolver/resolver.js";
import type { ParsedInput } from "../resolver/parseInput.js";
import { stageClock } from "./decide.js";
import type { KalosDrop } from "./types.js";

const iso = (sec: number) => new Date(sec * 1000).toISOString();

function clockStatus(start: number, end: number, nowSec: number): Stage["status"] {
  return stageClock(start, end, nowSec);
}

/** Stages from the drop object (times are UTC unix seconds). Allowlist stages need a proof; Public does not. */
export function kalosStages(drop: KalosDrop, nowSec = Math.floor(Date.now() / 1000)): Stage[] {
  const stages: Stage[] = [];
  for (const s of drop.stages ?? []) {
    stages.push({
      name: s.name.trim() || `Stage ${s.index}`,
      type: "allowlist",
      priceWei: s.priceWei,
      start: iso(s.start),
      end: iso(s.end),
      maxPerWallet: s.maxPerWallet,
      status: clockStatus(s.start, s.end, nowSec),
      source: "kalos",
      kalosIndex: s.index,
    });
  }
  if (drop.public) {
    const p = drop.public;
    stages.push({
      name: "Public",
      type: "public",
      priceWei: p.priceWei,
      start: iso(p.start),
      end: iso(p.end),
      maxPerWallet: p.maxPerWallet,
      status: clockStatus(p.start, p.end, nowSec),
      source: "kalos",
    });
  }
  return stages;
}

export function kalosResolved(opts: {
  drop: KalosDrop;
  input: string;
  parsed: ParsedInput;
  code: string;
  standard: ResolvedTarget["standard"];
  warning?: string;
  nowSec?: number;
  /** On-chain ERC-721 name/symbol: the collection display name when the drop carries none. */
  onChainName?: string | null;
  onChainSymbol?: string | null;
}): ResolvedTarget {
  const chain = requireChain("elysium");
  const drop = opts.drop;
  const max = drop.maxSupply != null ? String(drop.maxSupply) : null;
  const total = drop.totalSupply != null ? String(drop.totalSupply) : null;
  let remaining: string | null = null;
  if (max !== null && total !== null) {
    const r = BigInt(max) - BigInt(total);
    remaining = (r < 0n ? 0n : r).toString();
  }
  const stages = kalosStages(drop, opts.nowSec);
  const open = stages.some((s) => s.status !== "ended");
  return {
    input: opts.input,
    parsed: opts.parsed,
    chain: { key: chain.key, chainId: chain.chainId, name: chain.name, nativeSymbol: chain.nativeSymbol, explorer: chain.explorer },
    contract: getAddress(drop.address),
    kind: "seadrop",
    // Display name, never the slug: a drop without a display name falls back to the
    // on-chain contract name (usually the collection name) before the slug.
    name: drop.page?.displayName || drop.name || opts.onChainName || drop.slug,
    symbol: drop.symbol ?? opts.onChainSymbol ?? null,
    standard: opts.standard,
    slug: drop.slug,
    opensea: { apiKey: false, drop: null, error: null, url: null },
    seadrop: null,
    generic: null,
    stages,
    supply: { total, max, remaining },
    recommendedStrategy: open ? "kalos" : "none",
    dropSource: "kalos",
    kalos: {
      slug: drop.slug,
      seaDrop: getAddress(drop.seaDrop),
      feeRecipient: getAddress(drop.feeRecipient),
      feeBps: drop.feeBps,
      templateVersion: drop.templateVersion ?? "",
    },
    warnings: [...(opts.warning ? [opts.warning] : []), ...(remaining === "0" ? ["Sold out (remaining supply is 0)."] : [])],
    resolvedAt: new Date().toISOString(),
  };
}
