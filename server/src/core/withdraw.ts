// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Native-token withdraw / sweep from the user's own Privy wallets to ONE destination.
 *
 * Fee model (why "Max" can leave exactly 0):
 *  - Legacy (type-0) tx with a fixed gasPrice: on EIP-1559 chains a type-0 tx pays exactly gasUsed × gasPrice.
 *  - EOA → EOA transfer uses exactly 21 000 gas, so charged fee == reserved fee and value = balance − 21000 × gasPrice
 *    sweeps to 0 (Ethereum, Polygon, BNB, Arc).
 *  - OP Stack (Base, Unichain, Ink): an extra L1 data fee is charged from the balance. We quote it with
 *    GasPriceOracle.getL1Fee(signed-size tx) and reserve it with a small buffer (L1 fees move every L1 block), so the
 *    tx never fails; leftover is at most the buffer (a tiny fraction of the L1 fee).
 *  - Arbitrum stack (Arbitrum One, Robinhood): eth_estimateGas already includes L1 cost in gas units; it can move
 *    between quote and inclusion, so we add a 10% gas buffer. Unused gas and gasPrice above the base fee are refunded,
 *    so a tiny refund can remain.
 *  - Contract destinations: gas is estimated (+10%); unused gas is refunded → possible dust.
 * Signing happens in the user's browser (Privy embedded wallet). The server only quotes, validates and broadcasts.
 */
import { createHmac } from "node:crypto";
import { Contract, Signature, Transaction, ZeroAddress, formatEther, getAddress, isAddress, toBeHex } from "ethers";
import type { ChainConfig } from "../config/chains.js";
import type { RpcPool } from "./rpc/pool.js";
import { getFees } from "./mint/fees.js";

export const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = ["function getL1Fee(bytes _data) view returns (uint256)"];
export const EOA_TRANSFER_GAS = 21_000n;
/** L1 data fee reserve multiplier (percent). */
export const L1_FEE_BUFFER_PCT = 120n;
const GAS_BUFFER_PCT = 110n;
const QUOTE_TTL_MS = 10 * 60_000;

export type Amount = { kind: "max" } | { kind: "exact"; wei: bigint };

export interface SweepInput {
  balance: bigint;
  gasLimit: bigint;
  gasPrice: bigint;
  /** Quoted L1 data fee (OP Stack), before buffer. */
  l1Fee?: bigint;
  amount: Amount;
}
export interface SweepResult {
  value: bigint;
  /** Execution fee reserved: gasLimit × gasPrice. */
  gasFee: bigint;
  /** L1 data fee reserved (with buffer). */
  l1Reserve: bigint;
  fee: bigint;
  leftover: bigint;
  skip: string | null;
}

/** Pure fee math (unit-tested). */
export function computeSweep(i: SweepInput): SweepResult {
  const gasFee = i.gasLimit * i.gasPrice;
  const l1Reserve = i.l1Fee && i.l1Fee > 0n ? (i.l1Fee * L1_FEE_BUFFER_PCT + 99n) / 100n : 0n;
  const fee = gasFee + l1Reserve;
  if (i.amount.kind === "max") {
    if (i.balance <= fee)
      return {
        value: 0n,
        gasFee,
        l1Reserve,
        fee,
        leftover: i.balance,
        skip: `balance ${formatEther(i.balance)} does not cover the network fee ~${formatEther(fee)}`,
      };
    return { value: i.balance - fee, gasFee, l1Reserve, fee, leftover: 0n, skip: null };
  }
  if (i.amount.wei <= 0n) return { value: 0n, gasFee, l1Reserve, fee, leftover: i.balance, skip: "amount must be greater than 0" };
  if (i.amount.wei + fee > i.balance)
    return {
      value: 0n,
      gasFee,
      l1Reserve,
      fee,
      leftover: i.balance,
      skip: `insufficient balance: ${formatEther(i.amount.wei)} + fee ~${formatEther(fee)} > ${formatEther(i.balance)}`,
    };
  return { value: i.amount.wei, gasFee, l1Reserve, fee, leftover: i.balance - i.amount.wei - fee, skip: null };
}

/** Destination checks: valid EIP-55 checksum (or all one case), never the zero address. Returns the checksummed form. */
export function validateDestination(input: string): string {
  const s = (input ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw httpError("Destination must be a 0x address (40 hex characters).", 400, "BAD_ADDRESS");
  const hex = s.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && !isAddress(s)) throw httpError("Destination address checksum is invalid. Re-copy it from the source.", 400, "BAD_CHECKSUM");
  const a = getAddress(s.toLowerCase());
  if (a === ZeroAddress) throw httpError("Sending to the zero address is blocked.", 400, "ZERO_ADDRESS");
  return a;
}

/** Parse a decimal amount in native units ("0.5") to wei without float rounding. */
export function parseAmount(v: string, decimals = 18): Amount {
  if (v.trim().toLowerCase() === "max") return { kind: "max" };
  if (!/^\d+(\.\d+)?$/.test(v.trim())) throw httpError(`Invalid amount "${v}"`, 400, "BAD_AMOUNT");
  const [w, f = ""] = v.trim().split(".");
  if (f.length > decimals) throw httpError(`Too many decimals in "${v}"`, 400, "BAD_AMOUNT");
  return { kind: "exact", wei: BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0") };
}

/** Bytes the OP GasPriceOracle should price: the tx as it will be signed (dummy signature, same size). */
export function l1SizedTx(tx: { to: string; value: bigint; nonce: number; gasLimit: bigint; gasPrice: bigint; chainId: number }) {
  const t = Transaction.from({
    type: 0,
    to: tx.to,
    value: tx.value,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    chainId: tx.chainId,
    data: "0x",
  });
  t.signature = Signature.from({ r: "0x" + "ff".repeat(32), s: "0x" + "7f".repeat(32), v: 27 });
  return t.serialized;
}

export async function opL1Fee(pool: RpcPool, bytes: string): Promise<bigint> {
  return pool.read((p) => new Contract(OP_GAS_PRICE_ORACLE, ORACLE_ABI, p).getL1Fee(bytes) as Promise<bigint>, "getL1Fee");
}

/** Legacy gasPrice: base × 1.25 + tip (eco), never below the node's eth_gasPrice. Fully charged on type-0. */
export async function legacyGasPrice(pool: RpcPool): Promise<bigint> {
  const [eco, node] = await Promise.all([
    getFees(pool, "eco"),
    pool.read(async (p) => BigInt(await p.send("eth_gasPrice", [])), "gasPrice").catch(() => 0n),
  ]);
  return eco.maxFeePerGas > node ? eco.maxFeePerGas : node;
}

export interface UnsignedWithdrawTx {
  type: 0;
  chainId: number;
  to: string;
  value: string; // hex
  nonce: number;
  gasLimit: string; // hex
  gasPrice: string; // hex
  data: "0x";
}

export interface WithdrawQuoteItem {
  walletId: string;
  label: string;
  address: string;
  balanceWei: string;
  valueWei: string;
  feeWei: string;
  l1FeeWei: string;
  leftoverWei: string;
  gasLimit: string;
  gasPrice: string;
  skip: string | null;
  tx: UnsignedWithdrawTx | null;
  quoteToken: string | null;
  exactZero: boolean;
}

export async function quoteWallet(
  chain: ChainConfig,
  pool: RpcPool,
  w: { id: string; label: string; address: string },
  to: string,
  toIsContract: boolean,
  amount: Amount,
  gasPrice: bigint,
  userId: string,
  secret: Buffer,
): Promise<WithdrawQuoteItem> {
  const [balance, nonce] = await Promise.all([
    pool.read((p) => p.getBalance(w.address, "latest"), "balance"),
    pool.read((p) => p.getTransactionCount(w.address, "pending"), "nonce"),
  ]);
  let gasLimit = EOA_TRANSFER_GAS;
  if (toIsContract || chain.stack === "arbitrum") {
    const probe = amount.kind === "exact" ? amount.wei : balance > 0n ? 1n : 0n;
    const est = await pool
      .read((p) => p.estimateGas({ from: w.address, to, value: probe }), "estimateGas")
      .catch((e: any) => {
        throw httpError(
          `Gas estimate failed for ${w.label}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)}`,
          400,
          "ESTIMATE_FAILED",
        );
      });
    gasLimit = est === EOA_TRANSFER_GAS && !toIsContract ? est : (est * GAS_BUFFER_PCT + 99n) / 100n;
  }
  let l1Fee = 0n;
  if (chain.stack === "op") {
    l1Fee = await opL1Fee(pool, l1SizedTx({ to, value: balance, nonce, gasLimit, gasPrice, chainId: chain.chainId }));
  }
  const r = computeSweep({ balance, gasLimit, gasPrice, l1Fee, amount });
  const tx: UnsignedWithdrawTx | null = r.skip
    ? null
    : {
        type: 0,
        chainId: chain.chainId,
        to,
        value: toBeHex(r.value),
        nonce,
        gasLimit: toBeHex(gasLimit),
        gasPrice: toBeHex(gasPrice),
        data: "0x",
      };
  return {
    walletId: w.id,
    label: w.label,
    address: w.address,
    balanceWei: balance.toString(),
    valueWei: r.value.toString(),
    feeWei: r.fee.toString(),
    l1FeeWei: r.l1Reserve.toString(),
    leftoverWei: r.leftover.toString(),
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    skip: r.skip,
    tx,
    quoteToken: tx ? signQuote(secret, userId, w.id, w.address, tx, Date.now() + QUOTE_TTL_MS) : null,
    exactZero: amount.kind === "max" && !toIsContract && !chain.stack,
  };
}

/* ---------------------------- quote token + raw tx validation ---------------------------- */

function quoteBody(userId: string, walletId: string, from: string, tx: UnsignedWithdrawTx, exp: number) {
  return [
    userId,
    walletId,
    from.toLowerCase(),
    tx.chainId,
    tx.to.toLowerCase(),
    BigInt(tx.value),
    tx.nonce,
    BigInt(tx.gasLimit),
    BigInt(tx.gasPrice),
    exp,
  ].join("|");
}
export function signQuote(secret: Buffer, userId: string, walletId: string, from: string, tx: UnsignedWithdrawTx, exp: number) {
  return `${exp}.${createHmac("sha256", secret)
    .update(quoteBody(userId, walletId, from, tx, exp))
    .digest("base64url")}`;
}

/**
 * Turn the browser's Privy result into a broadcastable raw tx and prove it is EXACTLY the quoted transfer:
 * same sender (the user's wallet), destination, value, nonce, gas, chain, type-0, empty calldata.
 */
export function assembleAndVerify(opts: {
  secret: Buffer;
  userId: string;
  walletId: string;
  from: string;
  tx: UnsignedWithdrawTx;
  quoteToken: string;
  signed: string;
  now?: number;
}): { raw: string; hash: string } {
  const [expS, mac] = opts.quoteToken.split(".");
  const exp = Number(expS);
  if (!Number.isFinite(exp) || (opts.now ?? Date.now()) > exp)
    throw httpError("Quote expired — review the withdrawal again.", 410, "QUOTE_EXPIRED");
  const expect = signQuote(opts.secret, opts.userId, opts.walletId, opts.from, opts.tx, exp).split(".")[1];
  if (mac !== expect) throw httpError("Transaction does not match the reviewed quote.", 400, "QUOTE_MISMATCH");
  const sig = opts.signed.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) throw httpError("Malformed signed transaction", 400, "BAD_SIGNED_TX");
  let t: Transaction;
  if (sig.length === 132) {
    // Some Privy versions return only the 65-byte signature: attach it to the quoted tx.
    t = Transaction.from({
      ...opts.tx,
      value: BigInt(opts.tx.value),
      gasLimit: BigInt(opts.tx.gasLimit),
      gasPrice: BigInt(opts.tx.gasPrice),
    });
    t.signature = Signature.from(sig);
  } else t = Transaction.from(sig);
  if (!t.signature || !t.from) throw httpError("Transaction is not signed", 400, "BAD_SIGNED_TX");
  const same =
    t.type === 0 &&
    t.from.toLowerCase() === opts.from.toLowerCase() &&
    (t.to ?? "").toLowerCase() === opts.tx.to.toLowerCase() &&
    t.value === BigInt(opts.tx.value) &&
    t.nonce === opts.tx.nonce &&
    t.gasLimit === BigInt(opts.tx.gasLimit) &&
    t.gasPrice === BigInt(opts.tx.gasPrice) &&
    t.chainId === BigInt(opts.tx.chainId) &&
    (t.data === "0x" || t.data === "");
  if (!same) throw httpError("Signed transaction differs from the reviewed withdrawal — refusing to broadcast.", 400, "TX_MISMATCH");
  if ((t.to ?? "").toLowerCase() === ZeroAddress) throw httpError("Sending to the zero address is blocked.", 400, "ZERO_ADDRESS");
  return { raw: t.serialized, hash: t.hash! };
}

function httpError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}
