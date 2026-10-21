import { Contract, Interface, ZeroAddress, ZeroHash, getAddress } from "ethers";
import { isRetryable, type RpcPool } from "../rpc/pool.js";

/** OpenSea SeaDrop V1 — same address on every supported chain (verified on Ethereum and Base). */
export const SEADROP_ADDRESS = getAddress("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
/** OpenSea's standard fee recipient; used only when a drop does not restrict fee recipients. */
export const OPENSEA_FEE_RECIPIENT = getAddress("0x0000a26b00c1F0DF003000390027140000fAa719");

export const SEADROP_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32)",
  "function getSigners(address nftContract) view returns (address[])",
  "function getCreatorPayoutAddress(address nftContract) view returns (address)",
  "function getTokenGatedAllowedTokens(address nftContract) view returns (address[])",
];
export const SEADROP_TOKEN_ABI = [
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
];
export const seadropIface = new Interface(SEADROP_ABI);

export interface PublicDrop { mintPriceWei: string; startTime: number; endTime: number; maxPerWallet: number; feeBps: number; restrictFeeRecipients: boolean }
export interface SeaDropInfo {
  address: string;
  publicDrop: PublicDrop | null;
  feeRecipient: string | null;
  allowedFeeRecipients: string[];
  hasAllowList: boolean;
  hasSignedMints: boolean;
  hasTokenGated: boolean;
  creatorPayout: string | null;
  totalSupply: string | null;
  maxSupply: string | null;
}

export function decodePublicDrop(raw: any): PublicDrop | null {
  const d: PublicDrop = {
    mintPriceWei: BigInt(raw.mintPrice ?? raw[0]).toString(),
    startTime: Number(raw.startTime ?? raw[1]),
    endTime: Number(raw.endTime ?? raw[2]),
    maxPerWallet: Number(raw.maxTotalMintableByWallet ?? raw[3]),
    feeBps: Number(raw.feeBps ?? raw[4]),
    restrictFeeRecipients: Boolean(raw.restrictFeeRecipients ?? raw[5]),
  };
  if (d.startTime === 0 && d.endTime === 0 && d.maxPerWallet === 0) return null; // unset mapping
  return d;
}

export function pickFeeRecipient(allowed: string[], restricted: boolean): string | null {
  if (allowed.length) return getAddress(allowed[0]);
  return restricted ? null : OPENSEA_FEE_RECIPIENT;
}

/** Detect a SeaDrop V1 token by asking SeaDrop for its config and the token for getMintStats. */
export async function readSeaDrop(pool: RpcPool, nft: string): Promise<SeaDropInfo | null> {
  // Reverts/empty returns => null; transport errors rethrow so the pool rotates to another RPC.
  const safe = <T>(p: Promise<T>) => p.catch((e) => { if (isRetryable(e)) throw e; return null; });
  return pool.read(async (p) => {
    const sd = new Contract(SEADROP_ADDRESS, SEADROP_ABI, p);
    const tok = new Contract(nft, SEADROP_TOKEN_ABI, p);
    const [pub, stats, fees, root, signers, payout, gated] = await Promise.all([
      safe(sd.getPublicDrop(nft)), safe(tok.getMintStats(ZeroAddress)), safe(sd.getAllowedFeeRecipients(nft)),
      safe(sd.getAllowListMerkleRoot(nft)), safe(sd.getSigners(nft)), safe(sd.getCreatorPayoutAddress(nft)), safe(sd.getTokenGatedAllowedTokens(nft)),
    ]);
    const publicDrop = pub ? decodePublicDrop(pub) : null;
    const hasAllowList = Boolean(root && root !== ZeroHash);
    const signerList = (signers as string[] | null) ?? [];
    const gatedList = (gated as string[] | null) ?? [];
    const payoutAddr = payout && payout !== ZeroAddress ? String(payout) : null;
    // A SeaDrop token implements getMintStats; and SeaDrop holds some config for it.
    const isSeaDrop = stats !== null && (publicDrop !== null || hasAllowList || signerList.length > 0 || gatedList.length > 0 || payoutAddr !== null);
    if (!isSeaDrop) return null;
    const allowed = ((fees as string[] | null) ?? []).map((a) => getAddress(a));
    return {
      address: SEADROP_ADDRESS, publicDrop,
      feeRecipient: publicDrop ? pickFeeRecipient(allowed, publicDrop.restrictFeeRecipients) : allowed[0] ?? null,
      allowedFeeRecipients: allowed, hasAllowList, hasSignedMints: signerList.length > 0, hasTokenGated: gatedList.length > 0,
      creatorPayout: payoutAddr,
      totalSupply: stats ? BigInt((stats as any)[1]).toString() : null,
      maxSupply: stats ? BigInt((stats as any)[2]).toString() : null,
    };
  }, "seadrop");
}

export async function seadropMintedBy(pool: RpcPool, nft: string, wallet: string): Promise<number> {
  return pool.read(async (p) => Number((await new Contract(nft, SEADROP_TOKEN_ABI, p).getMintStats(wallet))[0]), "getMintStats");
}

export function encodeMintPublic(nft: string, feeRecipient: string, quantity: number): string {
  return seadropIface.encodeFunctionData("mintPublic", [nft, feeRecipient, ZeroAddress, BigInt(quantity)]);
}
