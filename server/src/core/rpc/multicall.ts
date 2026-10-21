// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) batching: N reads become ONE eth_call.
 * Deployed on every configured chain (eth_getCode verified 2026-10-21: Ethereum, Base, Polygon, Arbitrum,
 * BNB, Unichain, Ink, Robinhood, Arc). Every helper falls back to individual calls if the batch fails.
 */
import { Interface } from "ethers";
import type { RpcPool } from "./pool.js";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const multicallIface = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);
/** Calls per eth_call (keeps the request well under node gas / payload limits). */
export const MULTICALL_CHUNK = 150;

export interface McCall {
  target: string;
  data: string;
}
export type McResult = { success: boolean; returnData: string };

export function encodeAggregate3(calls: McCall[]): string {
  return multicallIface.encodeFunctionData("aggregate3", [calls.map((c) => [c.target, true, c.data])]);
}
export function decodeAggregate3(ret: string): McResult[] {
  const [rows] = multicallIface.decodeFunctionResult("aggregate3", ret);
  return (rows as any[]).map((r) => ({ success: Boolean(r[0]), returnData: String(r[1]) }));
}

/** One eth_call per chunk of up to MULTICALL_CHUNK calls; individual failures are reported, not thrown. */
export async function aggregate(pool: RpcPool, calls: McCall[], label = "multicall"): Promise<McResult[]> {
  const out: McResult[] = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const chunk = calls.slice(i, i + MULTICALL_CHUNK);
    const ret = await pool.read((p) => p.call({ to: MULTICALL3, data: encodeAggregate3(chunk) }), label);
    const rows = decodeAggregate3(ret);
    if (rows.length !== chunk.length) throw new Error("multicall: result length mismatch");
    out.push(...rows);
  }
  return out;
}

/** Native balances of many addresses at "latest" in one call (Multicall3.getEthBalance), with per-address fallback. */
export async function nativeBalancesBatch(pool: RpcPool, addresses: string[]): Promise<Map<string, bigint>> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, bigint>();
  if (!uniq.length) return out;
  if (uniq.length === 1) {
    out.set(uniq[0], await pool.read((p) => p.getBalance(uniq[0], "latest"), "balance"));
    return out;
  }
  try {
    const rows = await aggregate(
      pool,
      uniq.map((a) => ({ target: MULTICALL3, data: multicallIface.encodeFunctionData("getEthBalance", [a]) })),
      "balances",
    );
    rows.forEach((r, i) => {
      if (!r.success) throw new Error("getEthBalance failed");
      out.set(uniq[i], BigInt(multicallIface.decodeFunctionResult("getEthBalance", r.returnData)[0]));
    });
    return out;
  } catch {
    out.clear();
    await Promise.all(uniq.map(async (a) => out.set(a, await pool.read((p) => p.getBalance(a, "latest"), "balance"))));
    return out;
  }
}
