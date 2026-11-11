// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Draft-only NFT transfer. DO NOT MERGE.
 *
 * Discovery reuses the NFT indexer's Alchemy getNFTsForOwner (ALCHEMY_NFT_NETWORK + alchemyKey).
 * Chains absent from that map are manual entry only. Signing calls Privy eth_signTransaction directly
 * with the SIWE authorization context, not signRawTransaction, so the production selector denylist is unchanged.
 * Value is always 0. There is no amount cap.
 */
import { Contract, Interface, Transaction, getAddress, toQuantity } from "ethers";
import { getPrivy } from "../auth/privy.js";
import { CHAINS, explorerTx, type ChainConfig } from "../config/chains.js";
import { getFees } from "../core/mint/fees.js";
import { ALCHEMY_NFT_NETWORK, alchemyKey, scanAlchemy, type NftItem } from "../core/nft/indexer.js";
import { getPool } from "../core/rpc/pool.js";
import { describeTxError } from "../core/tx/revert.js";
import { validateDestination } from "../core/withdraw.js";
import { redactString } from "../util/log.js";
import {
  assertTestSendToken,
  fetchAllowlistedAddress,
  parseOptionalNonce,
  resolveTestSendChain,
  siweTestAuthorizationContext,
} from "./nativeSend.js";

export const ERC721_INTERFACE = "0x80ac58cd";
export const ERC1155_INTERFACE = "0xd9b67a26";
export const ERC721_SAFE_SELECTOR = "0x42842e0e";
export const ERC1155_SAFE_SELECTOR = "0xf242432a";
export const ERC1155_BATCH_SELECTOR = "0x2eb2c2d6";
const NFT_GAS_SANITY_CAP = 500_000n;

const ERC165 = new Interface(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]);
const ERC721 = new Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
const ERC1155 = new Interface([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

export type NftStandard = "erc721" | "erc1155";

export interface HeldNft {
  chainId: number;
  chainName: string;
  contract: string;
  tokenId: string;
  standard: NftStandard;
  balance: string | null;
  collection: string | null;
  name: string | null;
  image: string | null;
}

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

export function parseUint(value: string, label: string, opts?: { positive?: boolean }): bigint {
  const s = value.trim();
  if (!/^\d+$/.test(s)) throw httpError(`${label} must be a whole number.`, 400, "BAD_AMOUNT");
  const n = BigInt(s);
  if (opts?.positive && n <= 0n) throw httpError(`${label} must be greater than 0.`, 400, "BAD_AMOUNT");
  return n;
}

export function encodeNftTransfer(standard: NftStandard, from: string, to: string, tokenId: bigint, amount?: bigint): string {
  if (standard === "erc721") {
    const data = ERC721.encodeFunctionData("safeTransferFrom", [getAddress(from), getAddress(to), tokenId]);
    if (!data.toLowerCase().startsWith(ERC721_SAFE_SELECTOR)) {
      throw httpError("ERC-721 encoder did not produce selector 0x42842e0e.", 500, "ENCODER");
    }
    return data;
  }
  if (amount == null || amount <= 0n) throw httpError("ERC-1155 amount must be greater than 0.", 400, "BAD_AMOUNT");
  const data = ERC1155.encodeFunctionData("safeTransferFrom", [getAddress(from), getAddress(to), tokenId, amount, "0x"]);
  if (!data.toLowerCase().startsWith(ERC1155_SAFE_SELECTOR)) {
    throw httpError("ERC-1155 encoder did not produce selector 0xf242432a.", 500, "ENCODER");
  }
  return data;
}

/** One ERC-1155 safeBatchTransferFrom for several ids of the same contract. Value stays 0. */
export function encodeErc1155Batch(from: string, to: string, ids: bigint[], amounts: bigint[]): string {
  if (!ids.length || ids.length !== amounts.length)
    throw httpError("Batch token ids and amounts must be the same length.", 400, "BAD_AMOUNT");
  if (amounts.some((a) => a <= 0n)) throw httpError("ERC-1155 amount must be greater than 0.", 400, "BAD_AMOUNT");
  const data = ERC1155.encodeFunctionData("safeBatchTransferFrom", [getAddress(from), getAddress(to), ids, amounts, "0x"]);
  if (!data.toLowerCase().startsWith(ERC1155_BATCH_SELECTOR)) {
    throw httpError("ERC-1155 batch encoder did not produce selector 0x2eb2c2d6.", 500, "ENCODER");
  }
  return data;
}

async function supports(chain: ChainConfig, contract: string, id: string): Promise<boolean> {
  try {
    const raw = await getPool(chain).read(
      (p) => p.call({ to: contract, data: ERC165.encodeFunctionData("supportsInterface", [id]) }),
      "supportsInterface",
    );
    return Boolean(ERC165.decodeFunctionResult("supportsInterface", raw)[0]);
  } catch {
    return false;
  }
}

/** ERC-165. "both" and "neither" need the UI override. */
export async function detectNftStandard(chain: ChainConfig, contract: string): Promise<"erc721" | "erc1155" | "both" | "neither"> {
  const [erc721, erc1155] = await Promise.all([supports(chain, contract, ERC721_INTERFACE), supports(chain, contract, ERC1155_INTERFACE)]);
  if (erc721 && erc1155) return "both";
  if (erc721) return "erc721";
  if (erc1155) return "erc1155";
  return "neither";
}

function held(it: NftItem): boolean {
  if (it.standard === "erc721") return true;
  return it.quantity != null && /^[1-9]\d*$/.test(it.quantity);
}

/** Alchemy getNFTsForOwner on chains the NFT indexer already maps. Others stay manual. */
export async function discoverTestNfts(owner: string): Promise<{ nfts: HeldNft[]; note: string; errors: string[]; truncated: boolean }> {
  const manual = CHAINS.filter((c) => !ALCHEMY_NFT_NETWORK[c.key]).map((c) => c.name);
  const manualNote = manual.length ? ` No Alchemy NFT API in the repo for: ${manual.join(", ")}. Use contract and token id there.` : "";
  const key = alchemyKey();
  if (!key) {
    return {
      nfts: [],
      truncated: false,
      errors: [],
      note: `NFT discovery needs ALCHEMY_API_KEY, or an Alchemy RPC URL (the same key the NFT indexer uses). Enter a contract and token id manually.${manualNote}`,
    };
  }
  const errors: string[] = [];
  let truncated = false;
  const lists = await Promise.all(
    CHAINS.filter((c) => ALCHEMY_NFT_NETWORK[c.key]).map(async (chain) => {
      try {
        const scan = await scanAlchemy(chain, owner, globalThis.fetch as any);
        if (scan.truncated) truncated = true;
        return scan.items
          .filter(held)
          .slice(0, 80)
          .map((it): HeldNft => ({
            chainId: chain.chainId,
            chainName: chain.name,
            contract: it.contract,
            tokenId: it.tokenId,
            standard: it.standard,
            balance: it.standard === "erc1155" ? it.quantity : null,
            collection: it.collection,
            name: it.name,
            image: it.image,
          }));
      } catch (e: any) {
        errors.push(`${chain.name}: ${redactString(String(e?.message ?? e)).slice(0, 200)}`);
        return [] as HeldNft[];
      }
    }),
  );
  const nfts = lists.flat().slice(0, 240);
  if (lists.flat().length > nfts.length) truncated = true;
  return {
    nfts,
    truncated,
    errors,
    note: `NFTs come from Alchemy getNFTsForOwner on the chains the indexer already supports.${manualNote}`,
  };
}

export interface CheckedNftTransfer {
  from: string;
  contract: string;
  to: string;
  tokenId: bigint;
  amount: bigint | null;
  data: string;
  chainId: number;
  standard: NftStandard;
}

export function assertSignedNftTransfer(
  raw: string,
  expected: { from: string; contract: string; to: string; tokenId: bigint; amount: bigint | null; chainId: number; standard: NftStandard },
): CheckedNftTransfer {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
  let parsed: Transaction;
  try {
    parsed = Transaction.from(raw);
  } catch (e: any) {
    throw httpError(`Signed transaction could not be decoded: ${e?.message ?? e}`, 502, "SIGN_FAILED");
  }
  const chainId = parsed.chainId == null ? NaN : Number(parsed.chainId);
  if (chainId !== expected.chainId) {
    throw httpError(`Refusing to broadcast chain id ${String(parsed.chainId)}; the request selected ${expected.chainId}.`, 400, "TX_SHAPE");
  }
  const contract = parsed.to ? getAddress(parsed.to) : "";
  if (contract !== getAddress(expected.contract))
    throw httpError(`Refusing to broadcast to ${contract || "no contract"}.`, 400, "TX_SHAPE");
  if (parsed.value !== 0n) throw httpError("Refusing to broadcast an NFT transfer with a non-zero native value.", 400, "TX_SHAPE");
  const want = encodeNftTransfer(
    expected.standard,
    expected.from,
    expected.to,
    expected.tokenId,
    expected.amount ?? undefined,
  ).toLowerCase();
  if ((parsed.data ?? "").toLowerCase() !== want) {
    throw httpError("Refusing to broadcast calldata that is not the requested safeTransferFrom.", 400, "TX_SHAPE");
  }
  if (!parsed.from || getAddress(parsed.from) !== getAddress(expected.from)) {
    throw httpError("Signed sender does not match the fetched wallet.", 400, "TX_SHAPE");
  }
  return {
    from: getAddress(parsed.from),
    contract,
    to: getAddress(expected.to),
    tokenId: expected.tokenId,
    amount: expected.standard === "erc1155" ? expected.amount : null,
    data: want,
    chainId,
    standard: expected.standard,
  };
}

function stampFrom(e: unknown, from: string): never {
  if (e && typeof e === "object") (e as { from?: string }).from ??= from;
  throw e;
}

/** Several ERC-1155 ids of one contract, one safeBatchTransferFrom, value 0. */
async function runTestNftBatch(header: string | null | undefined, body: unknown) {
  assertTestSendToken(header);
  const ctx = siweTestAuthorizationContext();
  const b = body as Record<string, unknown>;
  const walletId = typeof b.walletId === "string" ? b.walletId.trim() : "";
  const contractRaw = typeof b.contract === "string" ? b.contract.trim() : "";
  const destination = typeof b.destination === "string" ? b.destination.trim() : "";
  const chainRaw = b.chainId;
  const chainId = typeof chainRaw === "number" ? chainRaw : typeof chainRaw === "string" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : NaN;
  const idRaw = b.tokenIds as unknown[];
  const amtRaw = Array.isArray(b.amounts) ? (b.amounts as unknown[]) : [];
  if (!walletId) throw httpError("Wallet is required.", 400, "BAD_WALLET");
  if (!Number.isInteger(chainId)) throw httpError("Chain is required.", 400, "BAD_CHAIN");
  if (!contractRaw) throw httpError("NFT contract is required.", 400, "BAD_TOKEN");
  if (!destination) throw httpError("Destination is required.", 400, "BAD_ADDRESS");
  if (!idRaw.length || idRaw.length !== amtRaw.length)
    throw httpError("Batch token ids and amounts must be the same length.", 400, "BAD_AMOUNT");
  const ids = idRaw.map((v) => parseUint(String(v), "Token id"));
  const amounts = amtRaw.map((v) => parseUint(String(v), "Amount", { positive: true }));
  const chain = resolveTestSendChain(chainId);
  const contract = validateDestination(contractRaw);
  const to = validateDestination(destination);
  const from = await fetchAllowlistedAddress(walletId);
  const pool = getPool(chain);
  for (let i = 0; i < ids.length; i++) {
    let bal: bigint;
    try {
      bal = (await pool.read((p) => new Contract(contract, ERC1155, p).balanceOf(from, ids[i]) as Promise<bigint>, "balanceOf")) as bigint;
    } catch (e: any) {
      throw httpError(`balanceOf failed: ${redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 300)}`, 400, "BALANCE_CHECK");
    }
    if (bal < amounts[i])
      throw httpError(
        `ERC-1155 balance ${bal.toString()} is below amount ${amounts[i].toString()} for id ${ids[i].toString()}.`,
        400,
        "INSUFFICIENT_BALANCE",
      );
  }
  const data = encodeErc1155Batch(from, to, ids, amounts);
  let gasLimit: bigint;
  try {
    gasLimit = await pool.read((p) => p.estimateGas({ from, to: contract, value: 0n, data }), "estimateGas");
  } catch (e) {
    const why = await describeTxError(e, { chain, contracts: [contract] });
    throw httpError(`Gas estimate failed: ${why.message}`, 400, "ESTIMATE_FAILED");
  }
  if (gasLimit < 21_000n) gasLimit = 21_000n;
  if (gasLimit > NFT_GAS_SANITY_CAP) {
    throw httpError(
      `Gas estimate ${gasLimit.toString()} exceeds the NFT transfer sanity cap of ${NFT_GAS_SANITY_CAP.toString()}.`,
      400,
      "GAS_CAP",
    );
  }
  const fees = await getFees(pool);
  const nonce = parseOptionalNonce(b.nonce) ?? (await pool.read((p) => p.getTransactionCount(from, "pending"), "nonce"));
  const res = await getPrivy()
    .wallets()
    .ethereum()
    .signTransaction(walletId, {
      params: {
        transaction: {
          to: contract,
          data,
          value: "0x0",
          nonce,
          chain_id: chain.chainId,
          gas_limit: toQuantity(gasLimit),
          max_fee_per_gas: toQuantity(fees.maxFeePerGas),
          max_priority_fee_per_gas: toQuantity(fees.maxPriorityFeePerGas),
          type: 2,
        },
      },
      authorization_context: ctx,
    } as any);
  const signed = (res as any)?.signed_transaction as string;
  if (typeof signed !== "string" || !/^0x[0-9a-fA-F]+$/.test(signed)) {
    throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
  }
  const parsed = Transaction.from(signed);
  if (parsed.value !== 0n || !parsed.to || getAddress(parsed.to) !== contract || (parsed.data ?? "").toLowerCase() !== data.toLowerCase()) {
    throw httpError("Refusing to broadcast calldata that is not the requested safeBatchTransferFrom.", 400, "TX_SHAPE");
  }
  if (!parsed.from || getAddress(parsed.from) !== from)
    throw httpError("Signed sender does not match the fetched wallet.", 400, "TX_SHAPE");
  const sent = await pool.broadcast(signed);
  if (!sent.accepted.length) {
    const msg = sent.errors.map((e) => redactString(e.error)).join("; ") || "no RPC accepted the transaction";
    throw httpError(`Broadcast failed (hash ${sent.hash}): ${msg}`, 502, "BROADCAST_FAILED");
  }
  return {
    txHash: sent.hash,
    explorer: explorerTx(chain, sent.hash),
    from,
    to,
    contract,
    tokenId: ids.map((id) => id.toString()).join(","),
    amount: amounts.map((a) => a.toString()).join(","),
    standard: "erc1155" as const,
    chainId: chain.chainId,
    nonce,
  };
}

/**
 * ERC-721 or ERC-1155 safeTransferFrom. Value is 0. Standard "auto" uses ERC-165.
 */
export async function runTestNftSend(header: string | null | undefined, body: unknown) {
  assertTestSendToken(header);
  if (body && typeof body === "object" && Array.isArray((body as { tokenIds?: unknown }).tokenIds)) {
    return runTestNftBatch(header, body);
  }
  const ctx = siweTestAuthorizationContext();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("JSON body required.", 400, "BAD_BODY");
  const b = body as Record<string, unknown>;
  const walletId = typeof b.walletId === "string" ? b.walletId.trim() : "";
  const contractRaw = typeof b.contract === "string" ? b.contract.trim() : "";
  const tokenIdRaw = typeof b.tokenId === "string" ? b.tokenId.trim() : typeof b.tokenId === "number" ? String(b.tokenId) : "";
  const destination = typeof b.destination === "string" ? b.destination.trim() : "";
  const standardRaw = typeof b.standard === "string" ? b.standard.trim() : "auto";
  const chainRaw = b.chainId;
  const chainId = typeof chainRaw === "number" ? chainRaw : typeof chainRaw === "string" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : NaN;
  if (!walletId) throw httpError("Wallet is required.", 400, "BAD_WALLET");
  if (!Number.isInteger(chainId)) throw httpError("Chain is required.", 400, "BAD_CHAIN");
  if (!contractRaw) throw httpError("NFT contract is required.", 400, "BAD_TOKEN");
  if (!tokenIdRaw) throw httpError("Token id is required.", 400, "BAD_AMOUNT");
  if (!destination) throw httpError("Destination is required.", 400, "BAD_ADDRESS");
  if (standardRaw !== "auto" && standardRaw !== "erc721" && standardRaw !== "erc1155") {
    throw httpError("Standard must be auto, erc721, or erc1155.", 400, "BAD_STANDARD");
  }

  const chain = resolveTestSendChain(chainId);
  const contract = validateDestination(contractRaw);
  const to = validateDestination(destination);
  const tokenId = parseUint(tokenIdRaw, "Token id");
  const from = await fetchAllowlistedAddress(walletId);

  let standard: NftStandard;
  if (standardRaw === "auto") {
    const detected = await detectNftStandard(chain, contract);
    if (detected === "both" || detected === "neither") {
      throw httpError(
        detected === "both"
          ? "Contract reports both ERC-721 and ERC-1155. Pick a standard."
          : "Contract did not report ERC-721 (0x80ac58cd) or ERC-1155 (0xd9b67a26). Pick a standard.",
        400,
        "BAD_STANDARD",
      );
    }
    standard = detected;
  } else standard = standardRaw;

  const pool = getPool(chain);
  let amount: bigint | null = null;
  if (standard === "erc721") {
    let owner: string;
    try {
      owner = await pool.read((p) => new Contract(contract, ERC721, p).ownerOf(tokenId) as Promise<string>, "ownerOf");
    } catch (e: any) {
      throw httpError(`ownerOf failed: ${redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 300)}`, 400, "OWNER_CHECK");
    }
    if (getAddress(owner) !== from) {
      throw httpError(`Token ${tokenId.toString()} is owned by ${getAddress(owner)}, not ${from}.`, 400, "NOT_OWNER");
    }
  } else {
    const amountRaw = typeof b.amount === "string" ? b.amount.trim() : "";
    if (!amountRaw) throw httpError("ERC-1155 amount is required.", 400, "BAD_AMOUNT");
    amount = parseUint(amountRaw, "Amount", { positive: true });
    let bal: bigint;
    try {
      bal = (await pool.read((p) => new Contract(contract, ERC1155, p).balanceOf(from, tokenId) as Promise<bigint>, "balanceOf")) as bigint;
    } catch (e: any) {
      throw httpError(`balanceOf failed: ${redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 300)}`, 400, "BALANCE_CHECK");
    }
    if (bal < amount) {
      throw httpError(`ERC-1155 balance ${bal.toString()} is below amount ${amount.toString()}.`, 400, "INSUFFICIENT_BALANCE");
    }
  }

  const data = encodeNftTransfer(standard, from, to, tokenId, amount ?? undefined);
  let gasLimit: bigint;
  try {
    gasLimit = await pool.read((p) => p.estimateGas({ from, to: contract, value: 0n, data }), "estimateGas");
  } catch (e) {
    const why = await describeTxError(e, { chain, contracts: [contract] });
    stampFrom(httpError(`Gas estimate failed: ${why.message}`, 400, "ESTIMATE_FAILED"), from);
  }
  if (gasLimit < 21_000n) gasLimit = 21_000n;
  if (gasLimit > NFT_GAS_SANITY_CAP) {
    stampFrom(
      httpError(
        `Gas estimate ${gasLimit.toString()} exceeds the NFT transfer sanity cap of ${NFT_GAS_SANITY_CAP.toString()}.`,
        400,
        "GAS_CAP",
      ),
      from,
    );
  }
  const fees = await getFees(pool);
  const nonce = parseOptionalNonce(b.nonce) ?? (await pool.read((p) => p.getTransactionCount(from, "pending"), "nonce"));

  let signed: string;
  try {
    const res = await getPrivy()
      .wallets()
      .ethereum()
      .signTransaction(walletId, {
        params: {
          transaction: {
            to: contract,
            data,
            value: "0x0",
            nonce,
            chain_id: chain.chainId,
            gas_limit: toQuantity(gasLimit),
            max_fee_per_gas: toQuantity(fees.maxFeePerGas),
            max_priority_fee_per_gas: toQuantity(fees.maxPriorityFeePerGas),
            type: 2,
          },
        },
        authorization_context: ctx,
      } as any);
    signed = (res as any)?.signed_transaction;
    if (typeof signed !== "string" || !/^0x[0-9a-fA-F]+$/.test(signed)) {
      throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
    }
  } catch (e) {
    stampFrom(e, from);
  }

  const checked = assertSignedNftTransfer(signed, { from, contract, to, tokenId, amount, chainId: chain.chainId, standard });
  const sent = await pool.broadcast(signed);
  if (!sent.accepted.length) {
    const msg = sent.errors.map((e) => redactString(e.error)).join("; ") || "no RPC accepted the transaction";
    stampFrom(httpError(`Broadcast failed (hash ${sent.hash}): ${msg}`, 502, "BROADCAST_FAILED"), from);
  }
  return {
    txHash: sent.hash,
    explorer: explorerTx(chain, sent.hash),
    from: checked.from,
    to: checked.to,
    contract: checked.contract,
    tokenId: checked.tokenId.toString(),
    amount: checked.amount?.toString() ?? null,
    standard: checked.standard,
    chainId: chain.chainId,
    nonce,
  };
}
