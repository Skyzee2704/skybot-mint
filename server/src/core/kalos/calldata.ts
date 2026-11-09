// SPDX-License-Identifier: AGPL-3.0-only
import { Interface, ZeroAddress, getAddress } from "ethers";
import type { KalosMintParams } from "./types.js";

const MINT_PARAMS =
  "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients)";

export const kalosIface = new Interface([
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS} mintParams, bytes32[] proof) payable`,
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function getAllowedSeaDrop() view returns (address[])",
]);

export function mintParamsTuple(p: KalosMintParams) {
  return [
    BigInt(p.mintPrice),
    BigInt(p.maxTotalMintableByWallet),
    BigInt(p.startTime),
    BigInt(p.endTime),
    BigInt(p.dropStageIndex),
    BigInt(p.maxTokenSupplyForStage),
    BigInt(p.feeBps),
    Boolean(p.restrictFeeRecipients),
  ] as const;
}

/** Allowlist calldata. mintParams and proof are copied verbatim so the merkle leaf matches. */
export function encodeMintAllowList(nft: string, feeRecipient: string, quantity: number, params: KalosMintParams, proof: string[]): string {
  return kalosIface.encodeFunctionData("mintAllowList", [
    getAddress(nft),
    getAddress(feeRecipient),
    ZeroAddress,
    BigInt(quantity),
    mintParamsTuple(params),
    proof,
  ]);
}

export function encodeKalosMintPublic(nft: string, feeRecipient: string, quantity: number): string {
  return kalosIface.encodeFunctionData("mintPublic", [getAddress(nft), getAddress(feeRecipient), ZeroAddress, BigInt(quantity)]);
}
