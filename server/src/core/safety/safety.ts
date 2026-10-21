import { formatEther, parseEther } from "ethers";
import { ChainConfig } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { getStore, Store } from "../store.js";

/** Selectors that move/approve assets. Never allowed in a mint transaction. */
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
  "0x8da5cb5b": "owner()", // not dangerous but never a mint
  "0xf2fde38b": "transferOwnership(address)",
  "0x3ccfd60b": "withdraw()",
};
const DANGEROUS_NAMES = /^(approve|setApprovalForAll|transfer|transferFrom|safeTransferFrom|safeBatchTransferFrom|increaseAllowance|permit|transferOwnership|withdraw|renounceOwnership)$/i;

export class SafetyError extends Error { statusCode = 422; constructor(m: string) { super(m); this.name = "SafetyError"; } }

/** Default cap values (used when a cap is enabled without a per-chain value). */
export function defaultCapValues(chain: ChainConfig) {
  return { maxPricePerNft: chain.safety?.maxPricePerNft ?? env.maxPricePerNft, maxDailySpend: chain.safety?.maxDailySpend ?? env.maxDailySpend };
}

/** Effective caps. `null` = unlimited (cap disabled in Settings — the default). */
export function capsFor(chain: ChainConfig, store: Store = getStore()) {
  const st = store.db.settings;
  const def = defaultCapValues(chain);
  const v = st.caps[chain.key] ?? {};
  return {
    maxPricePerNftWei: st.priceCapEnabled ? parseEther(v.maxPricePerNft ?? def.maxPricePerNft) : null,
    maxDailySpendWei: st.dailyCapEnabled ? parseEther(v.maxDailySpend ?? def.maxDailySpend) : null,
    maxGasPriceWei: BigInt(Math.round(env.maxGasPriceGwei * 1e9)),
  };
}
export const fmtCap = (w: bigint | null) => (w === null ? "unlimited" : formatEther(w));

export function isDangerousFunctionName(name: string) { return DANGEROUS_NAMES.test(name); }

export interface TxCheck { to: string; data: string; value: bigint; chainId: number }
/**
 * Guard every outgoing MINT tx:
 *  - chain id must match the selected chain
 *  - `to` must be one of the expected targets (SeaDrop or the resolved NFT contract)
 *  - selector must not be an approve/transfer-style call
 *  - value per NFT must be <= max price cap
 */
export function assertSafeMintTx(tx: TxCheck, ctx: { chain: ChainConfig; allowedTargets: string[]; quantity: number; expectedMaxValueWei?: bigint | null; store?: Store }) {
  if (tx.chainId !== ctx.chain.chainId) throw new SafetyError(`Chain ID mismatch: tx ${tx.chainId} vs selected ${ctx.chain.chainId}`);
  const to = tx.to.toLowerCase();
  if (!ctx.allowedTargets.map((a) => a.toLowerCase()).includes(to)) throw new SafetyError(`Blocked: tx target ${tx.to} is not the expected mint contract`);
  const sel = (tx.data || "0x").slice(0, 10).toLowerCase();
  if (DANGEROUS_SELECTORS[sel]) throw new SafetyError(`Blocked: ${DANGEROUS_SELECTORS[sel]} is never part of a mint`);
  if (!Number.isInteger(ctx.quantity) || ctx.quantity < 1) throw new SafetyError("Quantity must be >= 1");
  // Not a cap: OpenSea-built txs must not ask for more than the published stage price x qty.
  if (ctx.expectedMaxValueWei !== undefined && ctx.expectedMaxValueWei !== null && tx.value > ctx.expectedMaxValueWei)
    throw new SafetyError(`Blocked: tx value ${formatEther(tx.value)} is above the stage price x quantity (${formatEther(ctx.expectedMaxValueWei)} ${ctx.chain.nativeSymbol})`);
  const { maxPricePerNftWei } = capsFor(ctx.chain, ctx.store);
  const perNft = tx.value / BigInt(ctx.quantity);
  if (maxPricePerNftWei !== null && perNft > maxPricePerNftWei) throw new SafetyError(`Blocked: price ${formatEther(perNft)} ${ctx.chain.nativeSymbol}/NFT exceeds cap ${formatEther(maxPricePerNftWei)} (MAX_PRICE_PER_NFT)`);
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function dailySpent(chain: ChainConfig, store: Store = getStore(), day = utcDay()): bigint {
  return store.db.spend.filter((s) => s.chain === chain.key && s.day === day).reduce((a, s) => a + BigInt(s.wei), 0n);
}

export function assertDailyBudget(chain: ChainConfig, additionalWei: bigint, store: Store = getStore()) {
  const { maxDailySpendWei } = capsFor(chain, store);
  if (maxDailySpendWei === null) return;
  const spent = dailySpent(chain, store);
  if (spent + additionalWei > maxDailySpendWei) {
    throw new SafetyError(`Blocked: daily spend cap on ${chain.name} would be exceeded (spent ${formatEther(spent)} + this ${formatEther(additionalWei)} > cap ${formatEther(maxDailySpendWei)} ${chain.nativeSymbol}; MAX_DAILY_SPEND)`);
  }
}

export function recordSpend(chain: ChainConfig, wei: bigint, ref: string, store: Store = getStore()) {
  store.update((d) => { d.spend.push({ day: utcDay(), chain: chain.key, wei: wei.toString(), at: new Date().toISOString(), ref }); });
}
/** Replace a reservation (max cost) with the actual cost after the receipt. */
export function settleSpend(ref: string, actualWei: bigint, store: Store = getStore()) {
  store.update((d) => { const e = d.spend.find((s) => s.ref === ref); if (e) e.wei = actualWei.toString(); });
}
