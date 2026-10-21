// SPDX-License-Identifier: AGPL-3.0-only
/** Per-wallet quantity bounds, shared by the server (eligibility) and the dashboard steppers. */
export const HARD_MAX_PER_WALLET = 100;

/** Most this wallet may still mint: stage per-wallet limit minus already minted, capped by remaining supply. */
export function walletMaxQty(o: { maxPerWallet: number | null; minted: number | null; supplyRemaining?: number | null }): number {
  let max = HARD_MAX_PER_WALLET;
  if (o.maxPerWallet !== null && o.maxPerWallet > 0) max = Math.max(0, o.maxPerWallet - (o.minted ?? 0));
  if (o.supplyRemaining !== null && o.supplyRemaining !== undefined) max = Math.min(max, Math.max(0, o.supplyRemaining));
  return Math.min(max, 1000);
}

/** Clamp a typed / stepped quantity into [0, max] (0 = wallet not minting). */
export function clampQty(q: number, max: number): number {
  if (!Number.isFinite(q)) return max > 0 ? 1 : 0;
  return Math.max(0, Math.min(Math.floor(q), max));
}
