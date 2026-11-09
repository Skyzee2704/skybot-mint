// SPDX-License-Identifier: AGPL-3.0-only
/** Kalos launch API shapes, taken from live GET /v2/launch/drops and eligibility responses. */

export const KALOS_SEADROP = "0xCa10569ec3EdA292f435041d7610150e53119BaE";
export const OPENSEA_SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
export const KALOS_API = "https://api.kalos.fun";

export interface KalosWindow {
  priceWei: string;
  price?: string;
  start: number;
  end: number;
  maxPerWallet: number;
  feeBps?: number;
  stageSupply?: number;
}

export interface KalosAllowStage extends KalosWindow {
  index: number;
  name: string;
}

export interface KalosDrop {
  slug: string;
  address: string;
  seaDrop: string;
  feeRecipient: string;
  feeBps: number;
  templateVersion?: string;
  name?: string;
  symbol?: string;
  maxSupply?: number;
  totalSupply?: number;
  public?: KalosWindow | null;
  stages?: KalosAllowStage[];
  page?: { displayName?: string };
}

export interface KalosMintParams {
  mintPrice: string;
  maxTotalMintableByWallet: string;
  startTime: string;
  endTime: string;
  dropStageIndex: string;
  maxTokenSupplyForStage: string;
  feeBps: string;
  restrictFeeRecipients: boolean;
}

export interface KalosEntry {
  stageIndex: number;
  price?: string;
  stageName?: string;
  mintParams: KalosMintParams;
  proof: string[];
}

export interface KalosEligibility {
  minter: string;
  root?: string;
  published?: boolean;
  rootIsKalos?: boolean;
  entries: KalosEntry[];
}
