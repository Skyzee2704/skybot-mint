// SPDX-License-Identifier: AGPL-3.0-only
import type { RpcPool } from "../rpc/pool.js";
import { env } from "../../config/env.js";

export type GasMode = "eco" | "normal" | "aggressive";
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
  capped: boolean;
}

const TIP_MULT: Record<GasMode, number> = { eco: 1, normal: 1.25, aggressive: 2 };
const BASE_MULT: Record<GasMode, number> = { eco: 1.25, normal: 2, aggressive: 3 };
const MIN_TIP_WEI = 1_000_000n; // 0.001 gwei floor (L2s)

const mul = (v: bigint, m: number) => (v * BigInt(Math.round(m * 1000))) / 1000n;

/** Pure fee computation (unit-tested): maxFee = base*mult + tip, both capped at maxGasPriceWei. */
export function computeFees(baseFee: bigint, suggestedTip: bigint, mode: GasMode, maxGasPriceWei: bigint): Fees {
  let tip = mul(suggestedTip > 0n ? suggestedTip : MIN_TIP_WEI, TIP_MULT[mode]);
  if (tip < MIN_TIP_WEI) tip = MIN_TIP_WEI;
  let maxFee = mul(baseFee, BASE_MULT[mode]) + tip;
  let capped = false;
  if (maxFee > maxGasPriceWei) {
    maxFee = maxGasPriceWei;
    capped = true;
  }
  if (tip > maxFee) {
    tip = maxFee;
    capped = true;
  }
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, baseFee, capped };
}

export async function getFees(pool: RpcPool, mode: GasMode = env.gasMode): Promise<Fees> {
  const { baseFee, tip } = await pool.read(async (p) => {
    const [block, tipHex] = await Promise.all([p.getBlock("latest"), p.send("eth_maxPriorityFeePerGas", []).catch(() => null)]);
    return { baseFee: block?.baseFeePerGas ?? 0n, tip: tipHex ? BigInt(tipHex) : 1_000_000_000n };
  }, "fees");
  return computeFees(baseFee, tip, mode, BigInt(Math.round(env.maxGasPriceGwei * 1e9)));
}
