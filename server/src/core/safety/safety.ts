// SPDX-License-Identifier: AGPL-3.0-only
import { formatEther, parseEther } from "ethers";
import { ChainConfig } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { getSettings } from "../../users/service.js";
import { dailySpentWei, recordSpendRow, settleSpendRow } from "../jobs/repo.js";

export const DANGEROUS_SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve(address,uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "0x2eb2c2d6": "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  "0x39509351": "increaseAllowance(address,uint256)",
  "0xd505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "0x2b67b570": "permit2 permit",
  "0x87517c45": "permit2 approve",
  "0xf2fde38b": "transferOwnership(address)",
  "0x3ccfd60b": "withdraw()",
};
const DANGEROUS_NAMES =
  /^(approve|setApprovalForAll|transfer|transferFrom|safeTransferFrom|safeBatchTransferFrom|increaseAllowance|permit|transferOwnership|withdraw|renounceOwnership)$/i;

export class SafetyError extends Error {
  statusCode = 422;
  constructor(m: string) {
    super(m);
    this.name = "SafetyError";
  }
}

export function defaultCapValues(chain: ChainConfig) {
  return {
    maxPricePerNft: chain.safety?.maxPricePerNft ?? env.maxPricePerNft,
    maxDailySpend: chain.safety?.maxDailySpend ?? env.maxDailySpend,
  };
}

export async function capsFor(userId: string, chain: ChainConfig) {
  const st = await getSettings(userId);
  const def = defaultCapValues(chain);
  const v = st.caps[chain.key] ?? {};
  return {
    maxPricePerNftWei: st.priceCapEnabled ? parseEther(v.maxPricePerNft ?? def.maxPricePerNft) : null,
    maxDailySpendWei: st.dailyCapEnabled ? parseEther(v.maxDailySpend ?? def.maxDailySpend) : null,
    maxGasPriceWei: BigInt(Math.round(env.maxGasPriceGwei * 1e9)),
  };
}
export const fmtCap = (w: bigint | null) => (w === null ? "unlimited" : formatEther(w));
export function isDangerousFunctionName(name: string) {
  return DANGEROUS_NAMES.test(name);
}

export interface TxCheck {
  to: string;
  data: string;
  value: bigint;
  chainId: number;
}

export async function assertSafeMintTx(
  tx: TxCheck,
  ctx: { userId: string; chain: ChainConfig; allowedTargets: string[]; quantity: number; expectedMaxValueWei?: bigint | null },
) {
  if (tx.chainId !== ctx.chain.chainId) throw new SafetyError(`Chain ID mismatch: tx ${tx.chainId} vs selected ${ctx.chain.chainId}`);
  const to = tx.to.toLowerCase();
  if (!ctx.allowedTargets.map((a) => a.toLowerCase()).includes(to))
    throw new SafetyError(`Blocked: tx target ${tx.to} is not the expected mint contract`);
  const sel = (tx.data || "0x").slice(0, 10).toLowerCase();
  if (DANGEROUS_SELECTORS[sel]) throw new SafetyError(`Blocked: ${DANGEROUS_SELECTORS[sel]} is never part of a mint`);
  if (!Number.isInteger(ctx.quantity) || ctx.quantity < 1) throw new SafetyError("Quantity must be >= 1");
  if (ctx.expectedMaxValueWei !== undefined && ctx.expectedMaxValueWei !== null && tx.value > ctx.expectedMaxValueWei)
    throw new SafetyError(
      `Blocked: tx value ${formatEther(tx.value)} is above the stage price x quantity (${formatEther(ctx.expectedMaxValueWei)} ${ctx.chain.nativeSymbol})`,
    );
  const { maxPricePerNftWei } = await capsFor(ctx.userId, ctx.chain);
  const perNft = tx.value / BigInt(ctx.quantity);
  if (maxPricePerNftWei !== null && perNft > maxPricePerNftWei)
    throw new SafetyError(
      `Blocked: price ${formatEther(perNft)} ${ctx.chain.nativeSymbol}/NFT exceeds cap ${formatEther(maxPricePerNftWei)}`,
    );
}

export async function dailySpent(userId: string, chain: ChainConfig): Promise<bigint> {
  return dailySpentWei(userId, chain.key);
}

export async function assertDailyBudget(userId: string, chain: ChainConfig, additionalWei: bigint) {
  const { maxDailySpendWei } = await capsFor(userId, chain);
  if (maxDailySpendWei === null) return;
  const spent = await dailySpent(userId, chain);
  if (spent + additionalWei > maxDailySpendWei) {
    throw new SafetyError(
      `Blocked: daily spend cap on ${chain.name} would be exceeded (spent ${formatEther(spent)} + this ${formatEther(additionalWei)} > cap ${formatEther(maxDailySpendWei)} ${chain.nativeSymbol})`,
    );
  }
}

export async function recordSpend(userId: string, chain: ChainConfig, wei: bigint, ref: string) {
  await recordSpendRow(userId, chain.key, wei.toString(), ref);
}
export async function settleSpend(ref: string, actualWei: bigint) {
  await settleSpendRow(ref, actualWei.toString());
}
