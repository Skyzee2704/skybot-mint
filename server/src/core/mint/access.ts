// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Balance-independent access checks ("is this wallet allowed to mint?"), kept separate from "can it pay?".
 *
 *  1. eth_call + stateOverride: simulate the real mint tx while giving the wallet a huge fake balance,
 *     so only contract rules (stage active, limits, proofs, signatures) decide. Read-only, nothing signed.
 *  2. SeaDrop merkle allowlist: read AllowListUpdated(allowListURI) from SeaDrop logs; if the file is
 *     published in plaintext, compute membership locally and verify the merkle root.
 *     (OpenSea-hosted allowlists are PGP-encrypted to OpenSea, so this usually yields "encrypted".)
 *  3. OpenSea mint API classification is done in eligibility.ts (it checks allowlist before balance).
 */
import { AbiCoder, Interface, getAddress, keccak256, toQuantity, ZeroHash } from "ethers";
import type { RpcPool } from "../rpc/pool.js";
import type { ChainConfig } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { SEADROP_ADDRESS } from "../resolver/seadrop.js";

export type AllowStatus = "yes" | "no" | "unknown" | "public" | "n/a";
export interface AccessResult {
  status: AllowStatus;
  source: string;
  detail?: string;
}
export interface SimResult {
  ok: boolean | null;
  reason: string | null;
  source: string;
}

export const SEADROP_ERRORS = new Interface([
  "error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)",
  "error MintQuantityCannotBeZero()",
  "error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)",
  "error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)",
  "error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)",
  "error FeeRecipientCannotBeZeroAddress()",
  "error FeeRecipientNotPresent()",
  "error InvalidFeeBps(uint256 feeBps)",
  "error FeeRecipientNotAllowed()",
  "error PayerNotAllowed()",
  "error InvalidProof()",
  "error InvalidSignature(address recoveredSigner)",
  "error SignatureAlreadyUsed()",
  "error IncorrectPayment(uint256 got, uint256 want)",
  "error InvalidSignedMintPrice(uint256 got, uint256 minimum)",
  "error InvalidSignedMaxTotalMintableByWallet(uint256 got, uint256 maximum)",
  "error InvalidSignedStartTime(uint256 got, uint256 minimum)",
  "error InvalidSignedEndTime(uint256 got, uint256 maximum)",
  "error InvalidSignedMaxTokenSupplyForStage(uint256 got, uint256 maximum)",
  "error InvalidSignedFeeBps(uint256 got, uint256 minimumOrMaximum)",
  "error SignedMintsMustRestrictFeeRecipients()",
  "error TokenGatedNotTokenOwner(address nftContract, address allowedNftToken, uint256 allowedNftTokenId)",
  "error TokenGatedTokenIdAlreadyRedeemed(address nftContract, address allowedNftToken, uint256 allowedNftTokenId)",
  "error TokenGatedDropStageNotPresent()",
  "error OnlyINonFungibleSeaDropToken(address sender)",
]);

/** Human-readable revert reason from revert data (SeaDrop custom errors, Error(string), Panic). */
export function decodeRevert(data: string | null | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    const e = SEADROP_ERRORS.parseError(data);
    if (e) {
      if (e.name === "Error") return String(e.args[0]);
      if (e.name === "NotActive")
        return `NotActive (stage starts ${new Date(Number(e.args[1]) * 1000).toISOString()}, ends ${new Date(Number(e.args[2]) * 1000).toISOString()})`;
      return `${e.name}(${e.args.map((a: any) => a.toString()).join(", ")})`;
    }
  } catch {
    /* not a SeaDrop error */
  }
  try {
    if (data.startsWith("0x08c379a0")) return String(AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]);
    if (data.startsWith("0x4e487b71")) return `Panic(${AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0]})`;
  } catch {
    /* ignore */
  }
  return `revert ${data.slice(0, 10)}`;
}

/** Which access verdict a revert implies. */
export function classifyRevert(reason: string | null): AllowStatus {
  if (!reason) return "unknown";
  if (/InvalidProof|InvalidSignature|PayerNotAllowed|TokenGatedNotTokenOwner|TokenGatedTokenIdAlreadyRedeemed/.test(reason)) return "no";
  return "unknown";
}

const FAKE_BALANCE = "0x" + (10n ** 30n).toString(16);

function revertDataOf(e: any): string | null {
  const cands = [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data];
  for (const c of cands) {
    if (typeof c === "string" && /^0x[0-9a-fA-F]*$/.test(c)) return c;
    if (c && typeof c.data === "string") return c.data;
  }
  return null;
}

/**
 * eth_call the tx from `from` with a fake balance (stateOverride). Balance never decides the outcome.
 * Endpoints that ignore the override ("insufficient funds") are skipped by the pool's rotation.
 */
export async function simulateIgnoringBalance(
  pool: RpcPool,
  tx: { from: string; to: string; data: string; value: bigint },
): Promise<SimResult> {
  const from = getAddress(tx.from);
  const params = [
    { from, to: getAddress(tx.to), data: tx.data, value: toQuantity(tx.value) },
    "latest",
    { [from]: { balance: FAKE_BALANCE } },
  ];
  try {
    await pool.read(async (p) => {
      try {
        return await p.send("eth_call", params);
      } catch (e: any) {
        const m = String(e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? "");
        if (/insufficient funds|state ?override|not supported|unsupported|invalid params|too many arguments/i.test(m) && !revertDataOf(e))
          throw new Error(`stateOverride unsupported: ${m.slice(0, 80)}`);
        throw e;
      }
    }, "eth_call+stateOverride");
    return { ok: true, reason: null, source: "eth_call + stateOverride (fake balance)" };
  } catch (e: any) {
    const data = revertDataOf(e);
    if (data !== null || e?.code === "CALL_EXCEPTION") {
      return {
        ok: false,
        reason: decodeRevert(data) ?? String(e?.shortMessage ?? e?.reason ?? "execution reverted").slice(0, 200),
        source: "eth_call + stateOverride (fake balance)",
      };
    }
    return { ok: null, reason: `simulation unavailable: ${String(e?.message ?? e).slice(0, 160)}`, source: "eth_call + stateOverride" };
  }
}

/* ------------------------------- SeaDrop merkle allowlists ------------------------------- */

export const ALLOWLIST_UPDATED_TOPIC = "0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5"; // AllowListUpdated(address,bytes32,bytes32,string[],string)
const MINT_PARAMS =
  "tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)";
export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.filebase.io/ipfs/",
  "https://opensea-drops.mypinata.cloud/ipfs/",
];

export interface AllowListEntry {
  address: string;
  mintParams?: any;
}
export interface MerkleInfo {
  root: string;
  uri: string | null;
  state: "plaintext" | "encrypted" | "unavailable" | "no_uri" | "no_logs";
  detail?: string;
  rootVerified?: boolean;
  members?: Map<string, AllowListEntry>;
}

/** SeaDrop leaf: keccak256(abi.encode(minter, mintParams)). */
export function seadropLeaf(address: string, mp: any): string {
  const t = [
    mp.mintPrice,
    mp.maxTotalMintableByWallet,
    mp.startTime,
    mp.endTime,
    mp.dropStageIndex,
    mp.maxTokenSupplyForStage,
    mp.feeBps,
    Boolean(mp.restrictFeeRecipients),
  ].map((v, i) => (i === 7 ? v : BigInt(v ?? 0)));
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", MINT_PARAMS], [getAddress(address), t]));
}
const hashPair = (a: string, b: string) => keccak256(a.toLowerCase() < b.toLowerCase() ? a + b.slice(2) : b + a.slice(2));
/** Sorted-pair merkle root (OpenZeppelin/merkletreejs sortPairs; odd node promoted). */
export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) return ZeroHash;
  let layer = [...leaves];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  return layer[0];
}

/** Parse a plaintext allowlist: JSON array of addresses or of {address, ...mintParams}, or CSV/lines with addresses. */
export function parseAllowList(text: string): AllowListEntry[] | null {
  const t = text.trim();
  if (t.startsWith("-----BEGIN PGP")) return null;
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.allowList) ? j.allowList : Array.isArray(j?.addresses) ? j.addresses : null;
    if (!arr) return [];
    return arr
      .map((x: any) =>
        typeof x === "string"
          ? { address: x }
          : { address: x.address ?? x.minter ?? x.wallet, mintParams: x.mintParams ?? (x.mintPrice !== undefined ? x : undefined) },
      )
      .filter((x: AllowListEntry) => typeof x.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.address));
  } catch {
    return [...t.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => ({ address: m[0] }));
  }
}

async function fetchText(uri: string, fetchImpl: typeof fetch): Promise<string | null> {
  const urls = uri.startsWith("ipfs://")
    ? IPFS_GATEWAYS.map((g) => g + uri.slice(7).replace(/^ipfs\//, ""))
    : /\/ipfs\/(.+)$/.test(uri)
      ? [uri, ...IPFS_GATEWAYS.map((g) => g + uri.match(/\/ipfs\/(.+)$/)![1])]
      : [uri];
  for (const u of urls) {
    try {
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.text();
    } catch {
      /* next gateway */
    }
  }
  return null;
}

const merkleCache = new Map<string, { at: number; info: MerkleInfo }>();

/** Find the allowListURI for the current merkle root via Etherscan v2 logs and try to read it. */
export async function getMerkleInfo(chain: ChainConfig, nft: string, root: string, fetchImpl: typeof fetch = fetch): Promise<MerkleInfo> {
  if (!root || root === ZeroHash) return { root, uri: null, state: "no_uri", detail: "no merkle root set" };
  const key = `${chain.key}:${nft.toLowerCase()}:${root}`;
  const c = merkleCache.get(key);
  if (c && Date.now() - c.at < 30 * 60_000) return c.info;
  const done = (info: MerkleInfo) => {
    merkleCache.set(key, { at: Date.now(), info });
    return info;
  };
  if (!env.etherscanApiKey || !chain.etherscanV2)
    return done({
      root,
      uri: null,
      state: "no_logs",
      detail: "allowListURI lookup needs Etherscan v2 logs (ETHERSCAN_API_KEY, supported chain)",
    });
  const topic1 = "0x" + nft.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const url = `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=logs&action=getLogs&address=${SEADROP_ADDRESS}&topic0=${ALLOWLIST_UPDATED_TOPIC}&topic1=${topic1}&topic0_1_opr=and&fromBlock=0&toBlock=latest&apikey=${env.etherscanApiKey}`;
  let logs: any[] = [];
  try {
    const j: any = await (await fetchImpl(url, { signal: AbortSignal.timeout(20000) })).json();
    if (j?.status !== "1" && !/no records/i.test(String(j?.message)))
      return done({ root, uri: null, state: "no_logs", detail: `Etherscan logs: ${String(j?.result ?? j?.message).slice(0, 120)}` });
    logs = Array.isArray(j?.result) ? j.result : [];
  } catch (e: any) {
    return { root, uri: null, state: "no_logs", detail: `Etherscan logs failed: ${String(e.message).slice(0, 80)}` };
  }
  const match = [...logs].reverse().find((l) => (l.topics?.[3] ?? "").toLowerCase() === root.toLowerCase());
  if (!match) return done({ root, uri: null, state: "no_logs", detail: "no AllowListUpdated event for the current root" });
  const [, uri] = AbiCoder.defaultAbiCoder().decode(["string[]", "string"], match.data) as unknown as [string[], string];
  if (!uri) return done({ root, uri: null, state: "no_uri", detail: "creator did not publish an allowListURI" });
  const text = await fetchText(uri, fetchImpl);
  if (text === null) return { root, uri, state: "unavailable", detail: "allowListURI not reachable via IPFS gateways" };
  const entries = parseAllowList(text);
  if (entries === null)
    return done({ root, uri, state: "encrypted", detail: "allowlist is PGP-encrypted to OpenSea; only OpenSea can check membership" });
  const members = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
  let rootVerified: boolean | undefined;
  if (entries.length && entries.every((e) => e.mintParams)) {
    try {
      rootVerified = merkleRoot(entries.map((e) => seadropLeaf(e.address, e.mintParams))).toLowerCase() === root.toLowerCase();
    } catch {
      rootVerified = false;
    }
  }
  return done({
    root,
    uri,
    state: "plaintext",
    members,
    rootVerified,
    detail: `${members.size} addresses${rootVerified === true ? ", merkle root verified" : rootVerified === false ? ", root does NOT match" : ", root not verifiable (no mint params)"}`,
  });
}

export function merkleAccess(info: MerkleInfo | null, address: string): AccessResult | null {
  if (!info || (info.state === "no_uri" && info.detail === "no merkle root set")) return null;
  if (info.state !== "plaintext" || !info.members) return { status: "unknown", source: "SeaDrop merkle allowlist", detail: info.detail };
  if (info.rootVerified === false) return { status: "unknown", source: "SeaDrop allowListURI", detail: info.detail };
  return {
    status: info.members.has(address.toLowerCase()) ? "yes" : "no",
    source: `SeaDrop allowListURI${info.rootVerified ? " (root verified)" : ""}`,
    detail: info.detail,
  };
}
