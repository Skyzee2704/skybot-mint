import { formatEther } from "ethers";
import { requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { OpenSeaClient } from "../resolver/opensea.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { seadropMintedBy } from "../resolver/seadrop.js";
import { genericMintedBy } from "../resolver/generic.js";
import { wallets as walletSvc } from "../wallets/service.js";
import { getFees } from "./fees.js";
import { MintBuildError, buildMintTx } from "./build.js";
import { Strategy } from "./types.js";

export interface EligibilityRow {
  walletId: string; label: string; address: string; group: string | null;
  balanceWei: string; balance: string;
  mintedSoFar: number | null; maxPerWallet: number | null; remainingForWallet: number | null;
  suggestedQty: number; estCostWei: string; estCost: string;
  allowlist: "eligible" | "not_eligible" | "not_active" | "unknown" | "n/a";
  eligible: boolean; reasons: string[];
}

const DEFAULT_GAS: Record<Strategy, bigint> = { seadrop_public: 180_000n, opensea_api: 220_000n, generic: 200_000n };

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export function stagePriceWei(t: ResolvedTarget, strategy: Strategy): bigint | null {
  if (strategy === "seadrop_public") return t.seadrop?.publicDrop ? BigInt(t.seadrop.publicDrop.mintPriceWei) : null;
  if (strategy === "generic") return t.generic?.values.priceWei ? BigInt(t.generic.values.priceWei) : null;
  const s = t.stages.find((x) => x.source === "opensea" && x.status === "active") ?? t.stages.find((x) => x.status === "upcoming");
  return s?.priceWei ? BigInt(s.priceWei) : null;
}

/** Pure decision logic (unit-tested). */
export function decide(input: {
  balance: bigint; priceWei: bigint; gasCostWei: bigint; desiredQty: number;
  maxPerWallet: number | null; minted: number | null; supplyRemaining: bigint | null; stageEnded: boolean;
}) {
  const reasons: string[] = [];
  let remaining: number | null = null;
  if (input.maxPerWallet !== null && input.maxPerWallet > 0 && input.minted !== null) remaining = Math.max(0, input.maxPerWallet - input.minted);
  let qty = input.desiredQty;
  if (remaining !== null) qty = Math.min(qty, remaining);
  if (input.supplyRemaining !== null) qty = Math.min(qty, Number(input.supplyRemaining > 1000n ? 1000n : input.supplyRemaining));
  if (input.stageEnded) reasons.push("stage ended");
  if (remaining === 0) reasons.push("per-wallet limit reached");
  if (input.supplyRemaining === 0n) reasons.push("sold out");
  const q = Math.max(qty, 1);
  const cost = input.priceWei * BigInt(q) + input.gasCostWei;
  if (input.balance < cost) reasons.push(`insufficient balance (need ~${formatEther(cost)})`);
  return { suggestedQty: Math.max(0, qty), remaining, cost, reasons };
}

export async function checkEligibility(t: ResolvedTarget, strategy: Strategy, walletIds: string[] | null, desiredQty = 1, os = new OpenSeaClient()): Promise<{ rows: EligibilityRow[]; priceWei: string | null; maxFeePerGas: string; notes: string[] }> {
  const chain = requireChain(t.chain.key);
  const pool = getPool(chain);
  const list = walletSvc.list().filter((w) => !walletIds || walletIds.includes(w.id));
  const fees = await getFees(pool);
  const price = stagePriceWei(t, strategy) ?? 0n;
  const gasCost = DEFAULT_GAS[strategy] * fees.maxFeePerGas;
  const notes: string[] = [];
  if (stagePriceWei(t, strategy) === null) notes.push("Stage price unknown — cost excludes mint price.");
  const pubStage = t.stages.find((s) => s.type === "public" && s.source === "onchain");
  const stageEnded = strategy === "seadrop_public" ? pubStage?.status === "ended" : false;
  const maxPerWallet = strategy === "seadrop_public" ? t.seadrop?.publicDrop?.maxPerWallet ?? null
    : strategy === "generic" ? (t.generic?.values.maxPerWallet ? Number(t.generic.values.maxPerWallet) : null)
    : (t.stages.find((s) => s.source === "opensea" && s.status === "active")?.maxPerWallet ?? null);
  const supplyRemaining = t.supply.remaining !== null ? BigInt(t.supply.remaining) : null;
  const useOs = strategy === "opensea_api" && os.available && Boolean(t.slug);
  if (strategy === "opensea_api" && !useOs) notes.push("OpenSea API key or slug missing — allowlist status unknown.");

  const rows = await mapLimit(list, useOs ? 3 : 8, async (w): Promise<EligibilityRow> => {
    const [balance, minted] = await Promise.all([
      pool.read((p) => p.getBalance(w.address), "balance"),
      t.kind === "seadrop" ? seadropMintedBy(pool, t.contract, w.address).catch(() => null)
        : t.generic ? genericMintedBy(pool, t.contract, t.generic, w.address) : Promise.resolve(null),
    ]);
    const d = decide({ balance, priceWei: price, gasCostWei: gasCost, desiredQty, maxPerWallet, minted, supplyRemaining, stageEnded });
    let allowlist: EligibilityRow["allowlist"] = strategy === "opensea_api" ? "unknown" : "n/a";
    if (useOs && d.suggestedQty > 0) {
      try { await buildMintTx(t, { chain: chain.key, contract: t.contract, strategy, slug: t.slug, wallets: [] }, w.address, d.suggestedQty, os); allowlist = "eligible"; }
      catch (e: any) {
        if (e instanceof MintBuildError && e.code === "NOT_ELIGIBLE") { allowlist = "not_eligible"; d.reasons.push(e.message); }
        else if (e instanceof MintBuildError && e.code === "NOT_ACTIVE") { allowlist = "not_active"; }
        else d.reasons.push(`OpenSea check failed: ${String(e.message).slice(0, 120)}`);
      }
    }
    const eligible = d.reasons.length === 0 && d.suggestedQty > 0;
    return {
      walletId: w.id, label: w.label, address: w.address, group: w.group,
      balanceWei: balance.toString(), balance: formatEther(balance),
      mintedSoFar: minted, maxPerWallet, remainingForWallet: d.remaining, suggestedQty: d.suggestedQty,
      estCostWei: d.cost.toString(), estCost: formatEther(d.cost), allowlist, eligible, reasons: d.reasons,
    };
  });
  return { rows, priceWei: stagePriceWei(t, strategy)?.toString() ?? null, maxFeePerGas: fees.maxFeePerGas.toString(), notes };
}
