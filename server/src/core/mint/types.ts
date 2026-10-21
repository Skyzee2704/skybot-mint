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
}
export interface BuiltTx {
  to: string;
  data: string;
  value: bigint;
}
