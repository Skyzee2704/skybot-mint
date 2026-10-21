import { formatEther } from "ethers";
import { requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { getWallet } from "../../users/service.js";
import { assertDailyBudget, capsFor, dailySpent, fmtCap } from "../safety/safety.js";
import { buildMintTx } from "./build.js";
import { getFees } from "./fees.js";
import { MintRequest } from "./types.js";
import { createPlan } from "../plans.js";

export interface SimRow {
  walletId: string; label: string; address: string; quantity: number;
  ok: boolean; expectedRevertBeforeStart: boolean;
  gasEstimate: string | null; gasLimit: string; valueWei: string; maxGasCostWei: string; totalMaxWei: string;
  to: string | null; selector: string | null; error: string | null;
}

export function fallbackGas(strategy: MintRequest["strategy"], qty: number): bigint {
  const base = strategy === "generic" ? 200_000n : 160_000n;
  return base + 40_000n * BigInt(Math.max(0, qty - 1));
}

export function revertReason(e: any): string {
  return String(e?.reason ?? e?.revert?.name ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? e).slice(0, 240);
}

export async function simulateMint(t: ResolvedTarget, req: MintRequest, userId: string) {
  const chain = requireChain(t.chain.key);
  const pool = getPool(chain);
  await pool.checkChainId();
  const fees = await getFees(pool, req.gasMode);
  const runAtMs = req.runAt ? new Date(req.runAt).getTime() : Date.now();
  const beforeStart = runAtMs > Date.now() + 2000;

  const rows: SimRow[] = await Promise.all(req.wallets.map(async (wq): Promise<SimRow> => {
    const w = await getWallet(userId, wq.walletId);
    const base = { walletId: w.id, label: w.label, address: w.address, quantity: wq.quantity };
    let tx;
    try { tx = await buildMintTx(t, req, w.address, wq.quantity, undefined, userId); }
    catch (e: any) {
      const notActive = e.code === "NOT_ACTIVE";
      const gl = BigInt(req.gasLimit ?? fallbackGas(req.strategy, wq.quantity));
      return { ...base, ok: false, expectedRevertBeforeStart: notActive && beforeStart, gasEstimate: null, gasLimit: gl.toString(), valueWei: "0", maxGasCostWei: (gl * fees.maxFeePerGas).toString(), totalMaxWei: (gl * fees.maxFeePerGas).toString(), to: null, selector: null, error: e.message };
    }
    let gasEstimate: bigint | null = null; let error: string | null = null;
    try {
      await pool.read((p) => p.call({ from: w.address, to: tx.to, data: tx.data, value: tx.value }), "eth_call");
      gasEstimate = await pool.read((p) => p.estimateGas({ from: w.address, to: tx.to, data: tx.data, value: tx.value }), "estimateGas");
    } catch (e: any) { error = revertReason(e); }
    const gasLimit = BigInt(req.gasLimit ?? (gasEstimate ? (gasEstimate * 125n) / 100n : fallbackGas(req.strategy, wq.quantity)));
    const maxGas = gasLimit * fees.maxFeePerGas;
    return {
      ...base, ok: error === null, expectedRevertBeforeStart: error !== null && beforeStart,
      gasEstimate: gasEstimate?.toString() ?? null, gasLimit: gasLimit.toString(), valueWei: tx.value.toString(),
      maxGasCostWei: maxGas.toString(), totalMaxWei: (tx.value + maxGas).toString(), to: tx.to, selector: tx.data.slice(0, 10), error,
    };
  }));

  const totalValue = rows.reduce((a, r) => a + BigInt(r.valueWei), 0n);
  const totalGas = rows.reduce((a, r) => a + BigInt(r.maxGasCostWei), 0n);
  const totalNfts = rows.reduce((a, r) => a + r.quantity, 0);
  const blockers: string[] = [];
  try { await assertDailyBudget(userId, chain, totalValue + totalGas); } catch (e: any) { blockers.push(e.message); }
  const failed = rows.filter((r) => !r.ok && !r.expectedRevertBeforeStart);
  if (failed.length === rows.length && rows.length) blockers.push("Every wallet failed simulation");

  const caps = await capsFor(userId, chain);
  const summary = {
    chain: chain.key, nativeSymbol: chain.nativeSymbol, wallets: rows.length, totalNfts,
    totalValue: formatEther(totalValue), totalMaxGas: formatEther(totalGas), totalMax: formatEther(totalValue + totalGas),
    maxFeePerGasGwei: Number(fees.maxFeePerGas) / 1e9, priorityFeeGwei: Number(fees.maxPriorityFeePerGas) / 1e9, feesCapped: fees.capped,
    dailySpent: formatEther(await dailySpent(userId, chain)), dailyCap: fmtCap(caps.maxDailySpendWei), maxPricePerNft: fmtCap(caps.maxPricePerNftWei),
    runAt: req.runAt ?? null, scheduled: beforeStart,
  };
  const okRows = rows.filter((r) => r.ok || r.expectedRevertBeforeStart);
  const plan = blockers.length || okRows.length === 0 ? null
    : createPlan(userId, "mint", { request: { ...req, wallets: okRows.map((r) => ({ walletId: r.walletId, quantity: r.quantity })) }, gasHints: Object.fromEntries(rows.map((r) => [r.walletId, r.gasLimit])) }, `MINT ${totalNfts}`);
  return { rows, summary, blockers, planId: plan?.id ?? null, confirmPhrase: plan?.confirmPhrase ?? null };
}
