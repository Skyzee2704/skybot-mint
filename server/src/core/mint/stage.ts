// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedTarget } from "../resolver/resolver.js";
import type { Strategy } from "./types.js";

export function stagePriceWei(t: ResolvedTarget, strategy: Strategy): bigint | null {
  if (strategy === "seadrop_public") return t.seadrop?.publicDrop ? BigInt(t.seadrop.publicDrop.mintPriceWei) : null;
  if (strategy === "generic") return t.generic?.values.priceWei ? BigInt(t.generic.values.priceWei) : null;
  const s = osStage(t);
  return s.priceWei !== null ? BigInt(s.priceWei) : null;
}

/** Stage the OpenSea mint API will mint into: the drop's active stage, else its next stage, else resolved stages. */
export function osStage(t: ResolvedTarget): { priceWei: string | null; maxPerWallet: number | null } {
  const d = t.opensea?.drop;
  const raw = d?.active_stage ?? d?.next_stage;
  if (raw) return { priceWei: raw.price ?? null, maxPerWallet: raw.max_per_wallet ? Number(raw.max_per_wallet) : null };
  const s = t.stages.find((x) => x.status === "active") ?? t.stages.find((x) => x.status === "upcoming");
  return { priceWei: s?.priceWei ?? null, maxPerWallet: s?.maxPerWallet ?? null };
}
