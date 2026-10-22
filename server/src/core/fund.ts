// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fund Wallets: split native coin from the member's Main wallet evenly across their other wallets.
 *
 * One sender, N sequential transfers (nonce, nonce+1, …), each a type-0 native transfer with the same fee model as
 * Withdraw (see withdraw.ts): EOA → EOA uses exactly 21 000 gas; Arbitrum-stack chains and contract destinations
 * are estimated (+10%); OP Stack reserves the L1 data fee with a buffer. Signing happens in the member's browser
 * (Privy); the server only quotes, verifies the signed tx against an HMAC quote token and broadcasts.
 *
 * Rounding: every destination gets floor(total / N) wei; the remainder (< N wei) stays in Main.
 */
import { formatEther, toBeHex } from "ethers";
import type { ChainConfig } from "../config/chains.js";
import type { RpcPool } from "./rpc/pool.js";
import { EOA_TRANSFER_GAS, L1_FEE_BUFFER_PCT, l1SizedTx, opL1Fee, signQuote, type Amount, type UnsignedWithdrawTx } from "./withdraw.js";
import { describeTxError } from "./tx/revert.js";

export const FUND_MAX_TARGETS = 50;
const GAS_BUFFER_PCT = 110n;
const QUOTE_TTL_MS = 10 * 60_000;

export interface FundPlanInput {
  /** Main wallet balance (wei, fresh). */
  balance: bigint;
  /** Reserved network fee per transfer (wei), one entry per destination. */
  fees: bigint[];
  amount: Amount;
}
export interface FundPlan {
  /** Amount each destination receives. */
  perWallet: bigint;
  totalValue: bigint;
  totalFee: bigint;
  /** Rounding remainder of the split (stays in Main). */
  remainder: bigint;
  /** Main balance after all transfers, before refunds of unused gas. */
  leftover: bigint;
  error: string | null;
}

/** Pure split / Max / balance math (unit-tested). */
export function planFund(i: FundPlanInput): FundPlan {
  const n = BigInt(i.fees.length);
  const totalFee = i.fees.reduce((s, f) => s + f, 0n);
  const fail = (error: string): FundPlan => ({
    perWallet: 0n,
    totalValue: 0n,
    totalFee,
    remainder: 0n,
    leftover: i.balance,
    error,
  });
  if (n === 0n) return fail("Select at least one wallet to fund.");
  let total: bigint;
  if (i.amount.kind === "max") {
    total = i.balance - totalFee;
    if (total <= 0n)
      return fail(
        `Main balance ${formatEther(i.balance)} does not cover the network fees ~${formatEther(totalFee)} for ${n} transfer${n === 1n ? "" : "s"}.`,
      );
  } else total = i.amount.wei;
  if (total <= 0n) return fail("Amount must be greater than 0.");
  const perWallet = total / n;
  if (perWallet === 0n) return fail(`Amount is too small to split across ${n} wallets.`);
  const totalValue = perWallet * n;
  const remainder = total - totalValue;
  if (totalValue + totalFee > i.balance)
    return fail(
      `Insufficient Main balance: ${formatEther(totalValue)} + network fees ~${formatEther(totalFee)} > ${formatEther(i.balance)}.`,
    );
  return { perWallet, totalValue, totalFee, remainder, leftover: i.balance - totalValue - totalFee, error: null };
}

/**
 * Destinations for a fund request: the member's own wallets, never Main, no duplicates, in the member's wallet order
 * (oldest first). Pure (unit-tested).
 */
export function pickFundTargets<W extends { id: string; address: string; isMain: boolean }>(
  wallets: W[],
  ids: string[] | "all",
): { main: W; targets: W[] } {
  const main = wallets.find((w) => w.isMain);
  if (!main) throw httpError("Set a Main wallet first. Fund Wallets always sends from Main.", 400, "NO_MAIN");
  const others = wallets.filter((w) => !w.isMain && w.address.toLowerCase() !== main.address.toLowerCase());
  if (ids === "all") return { main, targets: others };
  const want = new Set(ids);
  if (want.has(main.id)) throw httpError("The Main wallet is the source and can't be a destination.", 400, "MAIN_AS_TARGET");
  const known = new Set(others.map((w) => w.id));
  for (const id of want) if (!known.has(id)) throw httpError("Wallet not found", 404, "WALLET_NOT_FOUND");
  return { main, targets: others.filter((w) => want.has(w.id)) };
}

export interface FundQuoteItem {
  walletId: string;
  label: string;
  address: string;
  valueWei: string;
  feeWei: string;
  tx: UnsignedWithdrawTx;
  quoteToken: string;
}

export async function quoteFund(opts: {
  chain: ChainConfig;
  pool: RpcPool;
  main: { id: string; label: string; address: string };
  targets: { id: string; label: string; address: string }[];
  amount: Amount;
  gasPrice: bigint;
  userId: string;
  secret: Buffer;
  now?: number;
}) {
  const { chain, pool, main, targets, gasPrice } = opts;
  if (targets.length > FUND_MAX_TARGETS) throw httpError(`Fund up to ${FUND_MAX_TARGETS} wallets at a time.`, 400, "TOO_MANY");
  const [balance, nonce, codes] = await Promise.all([
    pool.read((p) => p.getBalance(main.address, "latest"), "balance"),
    pool.read((p) => p.getTransactionCount(main.address, "pending"), "nonce"),
    Promise.all(targets.map((t) => pool.read((p) => p.getCode(t.address), "getCode"))),
  ]);
  // Gas per transfer: exact 21 000 for EOAs; estimated (+10%) on Arbitrum-stack chains or for contract wallets.
  const gasLimits = await Promise.all(
    targets.map(async (t, k) => {
      const isContract = codes[k] !== "0x";
      if (!isContract && chain.stack !== "arbitrum") return EOA_TRANSFER_GAS;
      const est = await pool
        .read((p) => p.estimateGas({ from: main.address, to: t.address, value: 1n }), "estimateGas")
        .catch(async (e: any) => {
          throw httpError(
            `Gas estimate failed for ${t.label}: ${(await describeTxError(e, { chain, contracts: [t.address] })).message}`,
            400,
            "ESTIMATE_FAILED",
          );
        });
      return est === EOA_TRANSFER_GAS && !isContract ? est : (est * GAS_BUFFER_PCT + 99n) / 100n;
    }),
  );
  // OP Stack L1 data fee: priced once on the largest possible tx (value = balance, highest nonce), reused for all.
  let l1Reserve = 0n;
  if (chain.stack === "op" && targets.length) {
    const maxGas = gasLimits.reduce((a, b) => (b > a ? b : a), 0n);
    const l1 = await opL1Fee(
      pool,
      l1SizedTx({
        to: targets[0].address,
        value: balance,
        nonce: nonce + targets.length - 1,
        gasLimit: maxGas,
        gasPrice,
        chainId: chain.chainId,
      }),
    );
    l1Reserve = l1 > 0n ? (l1 * L1_FEE_BUFFER_PCT + 99n) / 100n : 0n;
  }
  const fees = gasLimits.map((g) => g * gasPrice + l1Reserve);
  const plan = planFund({ balance, fees, amount: opts.amount });
  if (plan.error) throw Object.assign(httpError(plan.error, 400, "FUND_PLAN"), { balanceWei: balance.toString() });
  const exp = (opts.now ?? Date.now()) + QUOTE_TTL_MS;
  const items: FundQuoteItem[] = targets.map((t, k) => {
    const tx: UnsignedWithdrawTx = {
      type: 0,
      chainId: chain.chainId,
      to: t.address,
      value: toBeHex(plan.perWallet),
      nonce: nonce + k,
      gasLimit: toBeHex(gasLimits[k]),
      gasPrice: toBeHex(gasPrice),
      data: "0x",
    };
    return {
      walletId: t.id,
      label: t.label,
      address: t.address,
      valueWei: plan.perWallet.toString(),
      feeWei: fees[k].toString(),
      tx,
      quoteToken: signQuote(opts.secret, opts.userId, main.id, main.address, tx, exp),
    };
  });
  return {
    chain: chain.key,
    chainName: chain.name,
    nativeSymbol: chain.nativeSymbol,
    main: { id: main.id, label: main.label, address: main.address, balanceWei: balance.toString() },
    perWalletWei: plan.perWallet.toString(),
    totals: {
      valueWei: plan.totalValue.toString(),
      feeWei: plan.totalFee.toString(),
      remainderWei: plan.remainder.toString(),
      leftoverWei: plan.leftover.toString(),
    },
    items,
  };
}

function httpError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}
