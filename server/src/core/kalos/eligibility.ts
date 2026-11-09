// SPDX-License-Identifier: AGPL-3.0-only
import { getAddress } from "ethers";
import { requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { aggregate } from "../rpc/multicall.js";
import { nativeBalancesBatch } from "../rpc/multicall.js";
import { listWallets } from "../../users/service.js";
import { getFeesCached } from "../mint/fees.js";
import { nativeText } from "../../util/native.js";
import type { EligibilityRow } from "../mint/eligibility.js";
import type { ResolvedTarget } from "../resolver/resolver.js";
import { kalosIface } from "./calldata.js";
import { fetchKalosEligibility, mapPool } from "./client.js";
import { decideDrop, kalosReserveWei } from "./decide.js";
import type { KalosDrop, KalosEligibility } from "./types.js";

const GAS_UNITS = 180_000n;

function reasonText(d: { reason: string | null; want: number; clock: string }): string | null {
  if (!d.reason) return d.clock === "upcoming" ? null : null;
  if (d.reason.startsWith("insufficient")) return d.reason;
  if (d.reason === "cap reached") return `cap reached (want ${d.want})`;
  if (d.reason === "stage closed") return "stage closed";
  if (d.reason === "not on list") return "not on list";
  if (d.reason === "no proof") return "no proof";
  return d.reason;
}

/** Eligibility for a Kalos drop: API proof per wallet, shared getMintStats counter, HYPE including the reserve. */
export async function checkKalosEligibility(
  t: ResolvedTarget,
  userId: string,
  walletIds: string[] | null,
  drop: KalosDrop,
  fetchElig: (slug: string, wallet: string) => Promise<KalosEligibility> = fetchKalosEligibility,
) {
  const chain = requireChain(t.chain.key);
  const pool = getPool(chain);
  const list = (await listWallets(userId)).filter((w) => !walletIds || walletIds.includes(w.id));
  const fees = await getFeesCached(pool);
  const gasWei = GAS_UNITS * fees.maxFeePerGas;
  const reserve = kalosReserveWei(chain);
  const nowSec = Math.floor(Date.now() / 1000);
  const balances = await nativeBalancesBatch(
    pool,
    list.map((w) => w.address),
  ).catch(() => new Map<string, bigint>());
  const calls = list.map((w) => ({ target: t.contract, data: kalosIface.encodeFunctionData("getMintStats", [w.address]) }));
  const minted = new Map<string, number>();
  try {
    const rows = await aggregate(pool, calls, "kalos-mint-stats");
    list.forEach((w, i) => {
      const r = rows[i];
      if (!r?.success || !r.returnData || r.returnData === "0x") return;
      try {
        const n = Number(kalosIface.decodeFunctionResult("getMintStats", r.returnData)[0]);
        minted.set(w.address.toLowerCase(), n);
      } catch {
        /* leave unknown */
      }
    });
  } catch {
    /* stats unavailable: want uses minted 0 and a note */
  }
  const elig = await mapPool(list, 4, (w) => fetchElig(t.kalos?.slug ?? drop.slug, w.address).catch(() => null));
  const sym = chain.nativeSymbol;
  const rows: EligibilityRow[] = list.map((w, i) => {
    const mintedN = minted.get(w.address.toLowerCase()) ?? 0;
    const bal = balances.get(w.address.toLowerCase());
    const decisions = decideDrop({
      drop,
      elig: elig[i],
      minted: mintedN,
      nowSec,
      balanceWei: bal,
      gasWei,
      reserveWei: reserve,
      symbol: sym,
    });
    const openish = decisions.filter((d) => d.clock !== "ended");
    const best = openish.find((d) => d.eligible && d.clock === "active") ?? openish.find((d) => d.eligible) ?? openish[0] ?? null;
    const reasons = decisions.filter((d) => d.reason && d.clock !== "upcoming").map((d) => `${d.name}: ${reasonText(d)}`);
    if (best?.reason && best.clock === "active") {
      const line = `${best.name}: ${reasonText(best)}`;
      if (!reasons.includes(line)) reasons.unshift(line);
    }
    const insufficient = decisions.some((d) => d.reason?.startsWith("insufficient") && d.clock === "active" && d.eligible);
    if (insufficient && bal !== undefined && best) {
      const price = BigInt(best.priceWei || "0");
      const need = price * BigInt(Math.max(best.want, 1)) + gasWei + reserve;
      reasons.unshift(
        reserve > 0n
          ? `insufficient ${sym} (have ${nativeText(bal, sym)}, need ~${nativeText(need, sym)} including ${nativeText(reserve, sym)} left free)`
          : `insufficient ${sym} (have ${nativeText(bal, sym)}, need ~${nativeText(need, sym)})`,
      );
    }
    return {
      walletId: w.id,
      label: w.label,
      address: getAddress(w.address),
      balanceWei: (bal ?? 0n).toString(),
      balance: nativeText(bal ?? 0n, "").trim(),
      mintedSoFar: mintedN,
      maxPerWallet: best?.cap ?? null,
      remainingForWallet: best ? best.want : null,
      maxQty: best ? best.want : 0,
      suggestedQty: best && best.eligible && !best.reason?.startsWith("insufficient") ? best.want : 0,
      unitPriceWei: best?.priceWei ?? "0",
      gasCostWei: gasWei.toString(),
      estCostWei: best ? (BigInt(best.priceWei || "0") * BigInt(Math.max(best.want, 0)) + gasWei).toString() : gasWei.toString(),
      estCost: best ? nativeText(BigInt(best.priceWei || "0") * BigInt(Math.max(best.want, 0)) + gasWei, "").trim() : "0",
      access: {
        status: best?.kind === "public" && best.eligible ? "public" : best?.eligible ? "yes" : "no",
        source: "Kalos",
        detail: best ? `${best.name}${best.reason ? `: ${best.reason}` : ""}` : "no stage",
      } as EligibilityRow["access"],
      simulation: null,
      balanceOk: !insufficient,
      eligibleIgnoringBalance: Boolean(best?.eligible),
      eligible: Boolean(best?.eligible) && !insufficient,
      reasons: [...new Set(reasons.filter(Boolean) as string[])],
      allowlist: best?.kind === "public" ? "n/a" : best?.eligible ? "eligible" : "not_eligible",
      stages: decisions.map((d) => ({
        uuid: d.index === null ? null : String(d.index),
        label: d.name,
        type: d.kind === "public" ? "public" : "allowlist",
        start: null,
        eligible:
          d.clock === "ended" || d.reason === "cap reached" || d.reason === "not on list" || d.reason === "no proof"
            ? false
            : d.want > 0 && d.eligible,
        maxPerWallet: d.cap,
        priceWei: d.priceWei,
      })),
      needsOpenSeaLogin: false,
      unverifiedReason: null,
    };
  });
  const live = decideDrop({ drop, elig: { minter: "", entries: [] }, minted: 0, nowSec }).find((d) => d.clock === "active");
  return {
    rows,
    targetStage: live ? { label: live.name, type: live.kind === "public" ? "public" : "allowlist", start: null, active: true } : null,
    priceWei: live?.priceWei ?? null,
    maxFeePerGas: fees.maxFeePerGas.toString(),
    notes: [
      `Kalos · ${drop.slug}`,
      reserve > 0n ? `Leaves ${nativeText(reserve, sym)} free after each mint (KALOS_MINT_RESERVE or the chain default).` : "",
    ].filter(Boolean),
    noteItems: [],
    allowlistInfo: { source: "kalos", slug: drop.slug },
  };
}
