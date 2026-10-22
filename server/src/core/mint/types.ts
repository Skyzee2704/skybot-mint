// SPDX-License-Identifier: AGPL-3.0-only
import type { GasMode } from "./fees.js";

export type Strategy = "seadrop_public" | "opensea_api" | "generic";
export interface WalletQty {
  walletId: string;
  quantity: number;
}
export interface MintRequest {
  chain: string;
  contract: string;
  input?: string;
  strategy: Strategy;
  slug?: string | null;
  wallets: WalletQty[];
  generic?: { signature: string; priceWei: string; tokenId?: string };
  gasMode?: GasMode;
  gasLimit?: number;
  runAt?: string | null; // ISO; null/undefined = now
  offsetMs?: number; // broadcast offset relative to runAt (can be negative, >= -5000)
  /** Public stage only: include these wallets even though their simulation failed (explicit user override). */
  forceWalletIds?: string[];
  /**
   * Mint stage chosen on the Timing step (stage name as resolved). The server derives the run time (stage start, or
   * now while it is live) and the wallets (eligible ones only; every wallet for Public) from it.
   */
  stage?: string | null;
}
export interface BuiltTx {
  to: string;
  data: string;
  value: bigint;
}
