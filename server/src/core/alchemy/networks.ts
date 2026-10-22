// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Alchemy Notify (webhook) network ids per SkyBOT chain key, in sync priority order.
 * All are listed in the Notify API create-webhook enum (checked 2026-10-22). Ink has no Alchemy NFT API, but its
 * Address Activity webhook still keeps balances fresh and triggers an OpenSea re-scan; if Alchemy refuses Ink the
 * sync records the error and Ink simply keeps the manual Refresh.
 */
export const ALCHEMY_WEBHOOK_NETWORK: Record<string, string> = {
  ethereum: "ETH_MAINNET",
  base: "BASE_MAINNET",
  robinhood: "ROBINHOOD_MAINNET",
  arc: "ARC_MAINNET",
  polygon: "MATIC_MAINNET",
  arbitrum: "ARB_MAINNET",
  bnb: "BNB_MAINNET",
  unichain: "UNICHAIN_MAINNET",
  ink: "INK_MAINNET",
};

export const chainForNetwork = (network: string): string | null =>
  Object.entries(ALCHEMY_WEBHOOK_NETWORK).find(([, n]) => n === network)?.[0] ?? null;
