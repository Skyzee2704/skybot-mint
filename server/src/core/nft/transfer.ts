// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NFT send (ERC-721 / ERC-1155 safeTransferFrom) from the user's own Privy wallets to ONE destination.
 * Same trust model as native Withdraw: the server builds + quotes each transaction and HMAC-binds it; the browser
 * signs with Privy; the server proves the signed tx is byte-for-byte the quoted one before broadcasting.
 * Legacy type-0 transactions, value 0, calldata built here (never taken from the client).
 */
import { createHmac } from "node:crypto";
import { Interface, Signature, Transaction, ZeroAddress, getAddress, keccak256 } from "ethers";
import type { NftStandard } from "./indexer.js";

export const nftIface = new Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
const SEL_721 = nftIface.getFunction("safeTransferFrom(address,address,uint256)")!.selector;
const SEL_1155 = nftIface.getFunction("safeTransferFrom(address,address,uint256,uint256,bytes)")!.selector;
export const NFT_GAS_BUFFER_PCT = 120n;
export const NFT_QUOTE_TTL_MS = 10 * 60_000;

export interface UnsignedNftTx {
  type: 0;
  chainId: number;
  to: string; // NFT contract
  value: "0x0";
  nonce: number;
  gasLimit: string; // hex
  gasPrice: string; // hex
  data: string;
}

export function encodeTransfer(standard: NftStandard, from: string, to: string, tokenId: bigint, quantity: bigint): string {
  if (standard === "erc721") return nftIface.encodeFunctionData("safeTransferFrom(address,address,uint256)", [from, to, tokenId]);
  if (quantity <= 0n) throw new Error("quantity must be at least 1");
  return nftIface.encodeFunctionData("safeTransferFrom(address,address,uint256,uint256,bytes)", [from, to, tokenId, quantity, "0x"]);
}

/** Decode calldata we built (refuses anything that isn't one of the two safeTransferFrom forms). */
export function decodeTransfer(data: string): { standard: NftStandard; from: string; to: string; tokenId: bigint; quantity: bigint } {
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === SEL_721) {
    const [from, to, id] = nftIface.decodeFunctionData("safeTransferFrom(address,address,uint256)", data);
    return { standard: "erc721", from: getAddress(from), to: getAddress(to), tokenId: BigInt(id), quantity: 1n };
  }
  if (sel === SEL_1155) {
    const [from, to, id, amount] = nftIface.decodeFunctionData("safeTransferFrom(address,address,uint256,uint256,bytes)", data);
    return { standard: "erc1155", from: getAddress(from), to: getAddress(to), tokenId: BigInt(id), quantity: BigInt(amount) };
  }
  throw httpError("Not an NFT transfer", 400, "BAD_CALLDATA");
}

export const ownershipCall = (standard: NftStandard, owner: string, tokenId: bigint) =>
  standard === "erc721" ? nftIface.encodeFunctionData("ownerOf", [tokenId]) : nftIface.encodeFunctionData("balanceOf", [owner, tokenId]);

/** How many of the token `owner` holds according to an ownerOf / balanceOf result (null = undecodable / reverted). */
export function heldFrom(standard: NftStandard, owner: string, ok: boolean, ret: string): bigint | null {
  if (!ok || !ret || ret === "0x") return standard === "erc721" ? (ok ? null : 0n) : null;
  try {
    if (standard === "erc721") {
      const [o] = nftIface.decodeFunctionResult("ownerOf", ret);
      return String(o).toLowerCase() === owner.toLowerCase() ? 1n : 0n;
    }
    return BigInt(nftIface.decodeFunctionResult("balanceOf", ret)[0]);
  } catch {
    return null;
  }
}

export interface PlanItem {
  key: string;
  gasLimit: bigint;
  /** L1 data fee reserve (OP Stack), already buffered. */
  l1Fee: bigint;
}
/**
 * Gas check for one wallet on one chain (pure, unit-tested): include transfers in order while the wallet's native
 * balance covers their summed network fees; the rest are skipped with a clear reason instead of failing on-chain.
 */
export function planWalletGas(balance: bigint, gasPrice: bigint, items: PlanItem[]) {
  let spent = 0n;
  const out: { key: string; fee: bigint; ok: boolean; skip: string | null }[] = [];
  for (const it of items) {
    const fee = it.gasLimit * gasPrice + it.l1Fee;
    if (spent + fee <= balance) {
      spent += fee;
      out.push({ key: it.key, fee, ok: true, skip: null });
    } else out.push({ key: it.key, fee, ok: false, skip: "not enough native token for gas" });
  }
  return { items: out, totalFee: spent, needed: items.reduce((s, i) => s + i.gasLimit * gasPrice + i.l1Fee, 0n) };
}

/* ---------------------------- quote token + signed tx validation ---------------------------- */

function body(userId: string, walletId: string, from: string, tx: UnsignedNftTx, exp: number) {
  return [
    "nft-v1",
    userId,
    walletId,
    from.toLowerCase(),
    tx.chainId,
    tx.to.toLowerCase(),
    keccak256(tx.data.toLowerCase()),
    tx.nonce,
    BigInt(tx.gasLimit),
    BigInt(tx.gasPrice),
    exp,
  ].join("|");
}
export function signNftQuote(secret: Buffer, userId: string, walletId: string, from: string, tx: UnsignedNftTx, exp: number) {
  return `${exp}.${createHmac("sha256", secret)
    .update(body(userId, walletId, from, tx, exp))
    .digest("base64url")}`;
}

/** Prove the browser-signed tx is EXACTLY the quoted NFT transfer (sender, contract, calldata, nonce, gas, chain, value 0). */
export function verifySignedNftTx(opts: {
  secret: Buffer;
  userId: string;
  walletId: string;
  from: string;
  tx: UnsignedNftTx;
  quoteToken: string;
  signed: string;
  now?: number;
}): { raw: string; hash: string; transfer: ReturnType<typeof decodeTransfer> } {
  const [expS, mac] = opts.quoteToken.split(".");
  const exp = Number(expS);
  if (!Number.isFinite(exp) || (opts.now ?? Date.now()) > exp)
    throw httpError("Quote expired. Review the transfer again.", 410, "QUOTE_EXPIRED");
  const expect = signNftQuote(opts.secret, opts.userId, opts.walletId, opts.from, opts.tx, exp).split(".")[1];
  if (mac !== expect) throw httpError("Transaction does not match the reviewed transfer.", 400, "QUOTE_MISMATCH");
  const transfer = decodeTransfer(opts.tx.data);
  if (transfer.from.toLowerCase() !== opts.from.toLowerCase())
    throw httpError("Transfer must come from the signing wallet.", 400, "TX_MISMATCH");
  if (transfer.to === ZeroAddress) throw httpError("Sending to the zero address is blocked.", 400, "ZERO_ADDRESS");
  const sig = opts.signed.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) throw httpError("Malformed signed transaction", 400, "BAD_SIGNED_TX");
  let t: Transaction;
  const unsigned = {
    type: 0,
    chainId: opts.tx.chainId,
    to: opts.tx.to,
    value: 0n,
    nonce: opts.tx.nonce,
    gasLimit: BigInt(opts.tx.gasLimit),
    gasPrice: BigInt(opts.tx.gasPrice),
    data: opts.tx.data,
  };
  if (sig.length === 132) {
    t = Transaction.from(unsigned);
    t.signature = Signature.from(sig);
  } else t = Transaction.from(sig);
  if (!t.signature || !t.from) throw httpError("Transaction is not signed", 400, "BAD_SIGNED_TX");
  const same =
    t.type === 0 &&
    t.from.toLowerCase() === opts.from.toLowerCase() &&
    (t.to ?? "").toLowerCase() === opts.tx.to.toLowerCase() &&
    t.value === 0n &&
    t.nonce === opts.tx.nonce &&
    t.gasLimit === unsigned.gasLimit &&
    t.gasPrice === unsigned.gasPrice &&
    t.chainId === BigInt(opts.tx.chainId) &&
    t.data.toLowerCase() === opts.tx.data.toLowerCase();
  if (!same) throw httpError("Signed transaction differs from the reviewed transfer. Refusing to broadcast.", 400, "TX_MISMATCH");
  return { raw: t.serialized, hash: t.hash!, transfer };
}

export function httpError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}
