// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Revert decoding shared by Send NFT, Withdraw, Fund Wallets and mint simulation.
 * Order: Error(string) / Panic(uint256) -> bundled common custom errors -> the contract's verified ABI
 * (Etherscan v2 / Blockscout / Sourcify) -> public signature database (openchain). Lookups are cached.
 * Every result has a plain-English `message`; unknown errors keep the raw 4-byte selector as a detail.
 */
import { AbiCoder, ErrorFragment, Interface, formatEther, id } from "ethers";
import type { ChainConfig } from "../../config/chains.js";
import { redactString } from "../../util/log.js";

export interface DecodedRevert {
  /** 4-byte selector, e.g. "0x369c2f4c" (null for an empty revert). */
  selector: string | null;
  /** Error name when known, e.g. "ERC721InsufficientApproval". */
  name: string | null;
  args: string[];
  /** Plain-English explanation for the user. */
  message: string;
  /** Where the name came from. */
  via: "builtin" | "common" | "abi" | "signature-db" | "none";
}

/** Common NFT / token / access-control errors (OpenZeppelin v4/v5, ERC721A, Solady, Limit Break, OpenSea filter, Pausable). */
export const COMMON_ERRORS = [
  // OpenZeppelin v5 ERC721 / ERC1155 / ERC20
  "error ERC721InvalidOwner(address owner)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
  "error ERC721InvalidSender(address sender)",
  "error ERC721InvalidReceiver(address receiver)",
  "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
  "error ERC721InvalidApprover(address approver)",
  "error ERC721InvalidOperator(address operator)",
  "error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId)",
  "error ERC1155InvalidSender(address sender)",
  "error ERC1155InvalidReceiver(address receiver)",
  "error ERC1155MissingApprovalForAll(address operator, address owner)",
  "error ERC1155InvalidApprover(address approver)",
  "error ERC1155InvalidOperator(address operator)",
  "error ERC1155InvalidArrayLength(uint256 idsLength, uint256 valuesLength)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error OwnableUnauthorizedAccount(address account)",
  "error EnforcedPause()",
  // ERC721A / Solady
  "error TransferFromIncorrectOwner()",
  "error TransferCallerNotOwnerNorApproved()",
  "error TransferToNonERC721ReceiverImplementer()",
  "error TransferToZeroAddress()",
  "error OwnerQueryForNonexistentToken()",
  "error ApprovalCallerNotOwnerNorApproved()",
  "error NotOwnerNorApproved()",
  "error TokenDoesNotExist()",
  "error MintToZeroAddress()",
  "error MintZeroQuantity()",
  // OpenSea operator filter
  "error OperatorNotAllowed(address operator)",
  // Limit Break Creator Token Transfer Validator
  "error CreatorTokenTransferValidator__OTCNotAllowedFor7702Delegates()",
  "error CreatorTokenTransferValidator__CallerMustBeWhitelisted()",
  "error CreatorTokenTransferValidator__CallerMustHaveElevatedPermissionsForSpecifiedNFT()",
  "error CreatorTokenTransferValidator__OperatorIsBlacklisted()",
  "error CreatorTokenTransferValidator__ReceiverMustNotHaveDeployedCode()",
  "error CreatorTokenTransferValidator__ReceiverProofOfEOASignatureUnverified()",
  "error CreatorTokenTransferValidator__TokenIsSoulbound()",
  "error CreatorTokenTransferValidator__AuthorizationDisabledForCollection()",
  // Transfer locks seen in the wild
  "error TemporaryFriendLocked()",
  "error Soulbound()",
  "error TokenIsSoulbound()",
  "error NonTransferable()",
  "error NonTransferrable()",
  "error TransferLocked()",
  "error TokenLocked()",
  "error TransfersDisabled()",
  "error TransfersPaused()",
  "error TransferNotAllowed()",
  "error TransfersLocked()",
];
const COMMON = new Interface(COMMON_ERRORS);

const PANIC: Record<number, string> = {
  0x01: "assertion failed",
  0x11: "arithmetic overflow or underflow",
  0x12: "division by zero",
  0x21: "invalid enum value",
  0x22: "invalid storage data",
  0x31: "pop on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to an invalid internal function",
};

/** Plain-English explanation for a decoded error name (+ args). */
export function explainError(name: string, args: readonly unknown[] = []): string {
  const n = name.replace(/^.*__/, ""); // drop library prefixes such as CreatorTokenTransferValidator__
  if (/OTCNotAllowedFor7702Delegates/.test(name))
    return "This collection's transfer rules block direct transfers from wallets with an EIP-7702 smart-account delegation, and this wallet has one. Send it from a wallet without a delegation, or remove the delegation first.";
  if (/TemporaryFriendLocked/.test(name)) return "This token is temporarily locked by the collection and can't be transferred yet.";
  if (/Soulbound|NonTransfer/i.test(n)) return "This token is soulbound: the collection does not allow transfers.";
  if (/Transfers?(Locked|Disabled|Paused|NotAllowed)|TokenLocked|EnforcedPause/i.test(n))
    return "This collection has transfers locked or paused right now.";
  if (/OperatorNotAllowed|OperatorIsBlacklisted/.test(n)) return "The collection's transfer rules block this transfer method.";
  if (/CallerMustBeWhitelisted|ElevatedPermissions|AuthorizationDisabled/.test(n))
    return "The collection's transfer rules only allow approved marketplaces or operators to move this token.";
  if (/ReceiverMustNotHaveDeployedCode|ReceiverProofOfEOA/.test(n)) return "The collection's transfer rules don't allow this destination.";
  if (/IncorrectOwner|InvalidOwner|InsufficientBalance|TransferFromIncorrectOwner|InvalidSender/.test(n))
    return "The wallet no longer owns this token (or not enough of it). Refresh holdings.";
  if (/InsufficientApproval|MissingApprovalForAll|NotOwnerNorApproved|InsufficientAllowance/.test(n))
    return "The contract requires an approval for this transfer that the wallet hasn't given.";
  if (/InvalidReceiver|NonERC721ReceiverImplementer|ToZeroAddress/.test(n)) return "The destination can't receive this token.";
  if (/NonexistentToken|TokenDoesNotExist|NonexistentToken/.test(n)) return "This token doesn't exist (it may have been burned).";
  if (/OwnableUnauthorizedAccount/.test(n)) return "Only the contract owner can do this.";
  return `The contract rejected this with ${name}${args.length ? `(${args.map(String).join(", ")})` : ""}.`;
}

function explainString(s: string): string {
  if (/paused/i.test(s)) return `This contract is paused right now (${s}).`;
  if (/not (the )?owner|incorrect owner|owner query/i.test(s)) return `The wallet no longer owns this token (${s}).`;
  if (/approv/i.test(s)) return `The contract requires an approval for this transfer (${s}).`;
  if (/soulbound|non-?transfer|locked/i.test(s)) return `This collection has transfers locked (${s}).`;
  return `The contract rejected this: ${s}`;
}

const selectorOf = (data: string) => data.slice(0, 10).toLowerCase();

/** Synchronous decode: Error(string), Panic, bundled common errors, plus any extra ABI given. */
export function decodeRevertData(data: string | null | undefined, extraAbi?: Interface | null): DecodedRevert {
  if (!data || data === "0x")
    return { selector: null, name: null, args: [], message: "The contract rejected this without giving a reason.", via: "none" };
  const sel = selectorOf(data);
  try {
    if (sel === "0x08c379a0") {
      const s = String(AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]);
      return { selector: sel, name: "Error", args: [s], message: explainString(s), via: "builtin" };
    }
    if (sel === "0x4e487b71") {
      const c = Number(AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0]);
      return {
        selector: sel,
        name: "Panic",
        args: [String(c)],
        message: `The contract hit an internal error (${PANIC[c] ?? `panic 0x${c.toString(16)}`}).`,
        via: "builtin",
      };
    }
  } catch {
    /* malformed */
  }
  for (const [iface, via] of [
    [COMMON, "common"],
    [extraAbi, "abi"],
  ] as const) {
    if (!iface) continue;
    try {
      const e = iface.parseError(data);
      if (e && e.name !== "Error" && e.name !== "Panic") {
        const args = e.args.map((a: unknown) => String(a));
        return { selector: sel, name: e.name, args, message: explainError(e.name, args), via };
      }
    } catch {
      /* not in this ABI */
    }
  }
  return { selector: sel, name: null, args: [], message: `The contract rejected this (unknown error ${sel}).`, via: "none" };
}

/* ---------- async lookups (cached per process) ---------- */
const sigCache = new Map<string, { name: string | null; at: number }>();
const abiCache = new Map<string, { iface: Interface | null; at: number }>();
const TTL = 24 * 3600_000;

/** Public signature DB (openchain.xyz) — names only, args are not trusted for decoding beyond the signature. */
export async function lookupSelector(sel: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const hit = sigCache.get(sel);
  if (hit && Date.now() - hit.at < TTL) return hit.name;
  let name: string | null = null;
  try {
    const r = await fetchImpl(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`, {
      signal: AbortSignal.timeout(3000),
    });
    const j: any = await r.json();
    const cands: { name: string }[] = j?.result?.function?.[sel] ?? [];
    // Only accept a signature whose keccak really matches the selector.
    name = cands.map((c) => c.name).find((s) => id(s).slice(0, 10) === sel) ?? null;
  } catch {
    name = null;
  }
  sigCache.set(sel, { name, at: Date.now() });
  return name;
}

async function verifiedErrors(chain: ChainConfig, contract: string): Promise<Interface | null> {
  const k = `${chain.key}:${contract.toLowerCase()}`;
  const hit = abiCache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.iface;
  let iface: Interface | null = null;
  try {
    const { resolveAbi } = await import("../resolver/etherscan.js");
    const r = await Promise.race([resolveAbi(chain, contract), new Promise<null>((res) => setTimeout(() => res(null), 5000))]);
    const errs = (r?.abi ?? []).filter((x: any) => x?.type === "error");
    iface = errs.length ? new Interface(errs) : null;
  } catch {
    iface = null;
  }
  abiCache.set(k, { iface, at: Date.now() });
  return iface;
}

export interface RevertCtx {
  chain?: ChainConfig;
  /** Contracts whose verified ABI may define the error; a function is only called when the bundled table misses. */
  contracts?: string[] | (() => Promise<string[]>);
  fetchImpl?: typeof fetch;
}

/**
 * Full decode. `contracts` are the addresses whose verified ABI may define the error (the called contract first,
 * then e.g. its transfer validator). Network lookups only run for selectors the bundled table doesn't know.
 */
export async function explainRevert(data: string | null | undefined, ctx: RevertCtx = {}): Promise<DecodedRevert> {
  const d = decodeRevertData(data);
  if (d.via !== "none" || !d.selector) return d;
  const contracts = typeof ctx.contracts === "function" ? await ctx.contracts().catch(() => []) : (ctx.contracts ?? []);
  if (ctx.chain)
    for (const c of contracts) {
      const iface = await verifiedErrors(ctx.chain, c);
      const v = iface ? decodeRevertData(data, iface) : null;
      if (v && v.via === "abi") return v;
    }
  const sig = await lookupSelector(d.selector, ctx.fetchImpl);
  if (sig) {
    let args: string[] = [];
    try {
      const frag = ErrorFragment.from(`error ${sig}`);
      args = new Interface([frag]).parseError(data!)?.args.map((a: unknown) => String(a)) ?? [];
    } catch {
      /* name only */
    }
    const name = sig.replace(/\(.*$/, "");
    return { selector: d.selector, name, args, message: explainError(name, args), via: "signature-db" };
  }
  return d;
}

/** Revert data from an ethers / JSON-RPC error, wherever the provider put it. */
export function revertDataOf(e: any): string | null {
  const seen = new Set<any>();
  const walk = (x: any, depth: number): string | null => {
    if (!x || depth > 5 || seen.has(x)) return null;
    if (typeof x === "string") return /^0x([0-9a-fA-F]{2})*$/.test(x) && x.length >= 10 ? x : null;
    if (typeof x !== "object") return null;
    seen.add(x);
    for (const k of ["data", "revert", "error", "info", "cause", "body"]) {
      let v = x[k];
      if (k === "body" && typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {
          continue;
        }
      }
      if (k === "revert" && v?.data) v = v.data;
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(e, 0);
}

export const isInsufficientFunds = (e: any) =>
  e?.code === "INSUFFICIENT_FUNDS" ||
  /insufficient funds|insufficient balance for transfer/i.test(String(e?.shortMessage ?? e?.message ?? e));

/** "Not enough ETH for gas: need 0.0012 ETH, have 0.0003 ETH." */
export function gasShortfallMessage(needWei: bigint, haveWei: bigint, symbol: string): string {
  const f = (w: bigint) => {
    const s = formatEther(w);
    const [i, d = ""] = s.split(".");
    return d ? `${i}.${d.slice(0, 8).replace(/0+$/, "") || "0"}` : i;
  };
  return `Not enough ${symbol} for gas: need ${f(needWei)} ${symbol}, have ${f(haveWei)} ${symbol}.`;
}

/** Plain-English message for any tx/simulation error (revert decoded; selector kept as a small detail when unknown). */
export async function describeTxError(
  e: any,
  ctx: RevertCtx = {},
): Promise<{ message: string; selector: string | null; name: string | null }> {
  const data = revertDataOf(e);
  if (data) {
    const d = await explainRevert(data, ctx);
    return { message: d.message, selector: d.selector, name: d.name };
  }
  if (isInsufficientFunds(e))
    return { message: `Not enough ${ctx.chain?.nativeSymbol ?? "native token"} for gas.`, selector: null, name: null };
  const m = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  if (/execution reverted/i.test(m) && !/unknown custom error/i.test(m)) {
    const reason = e?.reason ? String(e.reason) : null;
    return { message: reason ? explainString(reason) : "The contract rejected this without giving a reason.", selector: null, name: null };
  }
  return { message: redactString(m).slice(0, 160), selector: null, name: null };
}
