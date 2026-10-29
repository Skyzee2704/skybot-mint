// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plain-English failure reasons for mint jobs (job page + Telegram), using the shared revert decoder instead of raw
 * provider text. Every helper is read-only: a reverted tx is explained by replaying it with eth_call, never re-sent.
 */
import type { ChainConfig } from "../../config/chains.js";
import { redactString } from "../../util/log.js";
import { describeTxError, isInsufficientFunds } from "../tx/revert.js";
import { privySigningRefusal } from "../../users/mintSigner.js";
import { MintBuildError } from "./build.js";

type Ctx = { chain: ChainConfig; contract: string };
const rc = (c: Ctx) => ({ chain: c.chain, contracts: [c.contract] });

/** Couldn't build the mint call (stage closed, not eligible, contract rejected the read, …). */
export async function buildFailureMessage(e: any, c: Ctx): Promise<string> {
  if (e instanceof MintBuildError) return redactString(String(e.message)).slice(0, 300);
  return `Couldn't prepare the mint: ${(await describeTxError(e, rc(c))).message}`;
}

/** Signing via Privy failed: authorization / policy refusals get a clear next step. */
export async function signFailureMessage(e: any, address: string, c: Ctx): Promise<string> {
  const refusal = privySigningRefusal(e, address);
  if (refusal) return refusal;
  if (isInsufficientFunds(e)) return `Not enough ${c.chain.nativeSymbol} for the mint price plus gas.`;
  return `Signing failed: ${(await describeTxError(e, rc(c))).message}`;
}

/** Every RPC refused the signed tx. */
export function broadcastRejectedMessage(errors: string[], symbol: string): string {
  const uniq = [...new Set(errors.map((x) => redactString(String(x))))];
  const all = uniq.join(" | ");
  const detail = all.slice(0, 200);
  if (/insufficient funds|insufficient balance/i.test(all))
    return `Not enough ${symbol} for the mint price plus gas (nothing was spent). RPC said: ${detail}`;
  if (/nonce too low|already known|replacement transaction underpriced/i.test(all))
    return `Another transaction from this wallet used the same nonce first, so this one wasn't accepted. RPC said: ${detail}`;
  if (/fee cap|max fee per gas less than block base fee|underpriced/i.test(all))
    return `Gas price was below the network's current base fee, so the network refused it (nothing was spent). RPC said: ${detail}`;
  if (/execution reverted/i.test(all)) return `The network refused it because the mint would revert. RPC said: ${detail}`;
  return `Rejected by all RPCs: ${all.slice(0, 300)}`;
}

/**
 * A mined tx reverted: replay it with eth_call at its block (read-only) and decode why.
 * `call` is the provider read; `gasLimit` / `gasUsed` spot out-of-gas reverts.
 */
export async function revertedOnChainMessage(
  call: (blockTag: number) => Promise<unknown>,
  blockNumber: number,
  gasUsed: bigint,
  gasLimit: bigint | null,
  c: Ctx,
): Promise<string> {
  if (gasLimit && gasUsed >= gasLimit) return `Reverted on-chain: ran out of gas (used all ${gasLimit} gas).`;
  for (const tag of [blockNumber - 1, blockNumber]) {
    try {
      await call(tag);
    } catch (e: any) {
      return `Reverted on-chain: ${(await describeTxError(e, rc(c))).message}`;
    }
  }
  return "Reverted on-chain (the replay passes now, so the contract state changed in that block — e.g. supply ran out or the stage closed).";
}

/** Whole-job failure outside the per-wallet steps. */
export async function jobFailureMessage(e: any, c?: Ctx): Promise<string> {
  if (e instanceof MintBuildError) return redactString(String(e.message)).slice(0, 400);
  return (await describeTxError(e, c ? rc(c) : {})).message.slice(0, 400);
}
