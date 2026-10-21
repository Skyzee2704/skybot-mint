// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wallet removal.
 * - "delete": only when the wallet is empty on every configured chain (and holds no SkyBOT-minted NFTs).
 *   The wallet is archived in Privy (POST /v1/wallets/{id}/archive — Privy has no hard delete), then our
 *   row is deleted and a tombstone stops Privy sync from re-adding it.
 *   The user's primary embedded wallet (wallet_index 0, not imported) is never archived — it is hidden instead.
 * - "hide": soft delete (removed_at). Funds stay in Privy custody; restorable from the Wallets page.
 */
import { formatEther } from "ethers";
import { and, eq } from "drizzle-orm";
import { CHAINS } from "../config/chains.js";
import { privyConfigured } from "../config/env.js";
import { getPool } from "../core/rpc/pool.js";
import { getDb } from "../db/client.js";
import { minted } from "../db/schema.js";
import { getPrivy } from "../auth/privy.js";
import { log, redactString } from "../util/log.js";
import { cachedNftCount } from "../core/nft/holdings.js";
import { getWallet, hardDeleteWallet, hideWallet, type AppUser } from "./service.js";

export interface ChainBalance {
  chain: string;
  chainName: string;
  symbol: string;
  balanceWei: string | null;
  balance: string | null;
  error: string | null;
}

export interface PrivyWalletInfo {
  /** Privy wallet id usable with the archive endpoint, if known. */
  id: string | null;
  /** The user's first embedded wallet (Privy creates it on login). Never archived. */
  primaryEmbedded: boolean;
  imported: boolean;
}

export interface RemovalCheck {
  walletId: string;
  label: string;
  address: string;
  balances: ChainBalance[];
  funded: ChainBalance[];
  unchecked: ChainBalance[];
  mintedNfts: number;
  /** Non-spam NFTs per the cached holdings scan. */
  heldNfts?: number;
  primaryEmbedded: boolean;
  /** Empty everywhere we can check → may be deleted for real. */
  canDelete: boolean;
  /** What "delete" will actually do. */
  deleteMode: "archive_and_delete" | "delete_local" | "hide_only";
  notes: string[];
}

const looksLikePrivyId = (s: string | null | undefined) => Boolean(s && !/^0x[0-9a-fA-F]{40}$/.test(s) && /^[a-z0-9]{16,40}$/i.test(s));

/** Pure decision used by the API and tests. */
export function decideRemoval(input: {
  balances: ChainBalance[];
  mintedNfts: number;
  privy: PrivyWalletInfo;
  privyAvailable: boolean;
  /** Non-spam NFTs from the cached holdings scan (NFTs page). */
  heldNfts?: { total: number; byChain: { chain: string; count: number }[] };
}): Pick<RemovalCheck, "funded" | "unchecked" | "canDelete" | "deleteMode" | "notes" | "primaryEmbedded"> {
  const funded = input.balances.filter((b) => b.balanceWei !== null && BigInt(b.balanceWei) > 0n);
  const unchecked = input.balances.filter((b) => b.balanceWei === null);
  const held = input.heldNfts?.total ?? 0;
  const canDelete = funded.length === 0 && unchecked.length === 0 && input.mintedNfts === 0 && held === 0;
  const notes: string[] = [
    "Tokens (ERC-20) are not checked, and NFTs are checked from the last holdings scan on the NFTs page. Move them out first if you have any.",
  ];
  let deleteMode: RemovalCheck["deleteMode"];
  if (input.privy.primaryEmbedded) {
    deleteMode = "hide_only";
    notes.push("This is your main Privy embedded wallet. Privy doesn't allow removing it, so SkyBOT can only hide it.");
  } else if (input.privy.id && input.privyAvailable) deleteMode = "archive_and_delete";
  else {
    deleteMode = "delete_local";
    notes.push("Privy wallet id unknown, so the wallet is removed from SkyBOT only and stays in your Privy account.");
  }
  if (unchecked.length) notes.push(`Couldn't read the balance on ${unchecked.map((u) => u.chainName).join(", ")}. Try again later.`);
  if (held)
    notes.push(
      `The last holdings scan shows ${held} NFT(s) in this wallet (${input.heldNfts!.byChain.map((c) => `${c.count} on ${c.chain}`).join(", ")}). Send them out on the NFTs page before deleting.`,
    );
  if (input.mintedNfts) notes.push(`This wallet minted ${input.mintedNfts} NFT(s) with SkyBOT. Transfer them out before deleting.`);
  return { funded, unchecked, canDelete, deleteMode, notes, primaryEmbedded: input.privy.primaryEmbedded };
}

async function nativeBalances(address: string): Promise<ChainBalance[]> {
  return Promise.all(
    CHAINS.map(async (c) => {
      try {
        const wei = await getPool(c).read((p) => p.getBalance(address), "balance");
        return {
          chain: c.key,
          chainName: c.name,
          symbol: c.nativeSymbol,
          balanceWei: wei.toString(),
          balance: formatEther(wei),
          error: null,
        };
      } catch (e: any) {
        return {
          chain: c.key,
          chainName: c.name,
          symbol: c.nativeSymbol,
          balanceWei: null,
          balance: null,
          error: redactString(String(e?.message ?? e)).slice(0, 120),
        };
      }
    }),
  );
}

async function privyInfo(user: AppUser, w: { address: string; privyWalletId: string | null }): Promise<PrivyWalletInfo> {
  const fallback: PrivyWalletInfo = {
    id: looksLikePrivyId(w.privyWalletId) ? w.privyWalletId : null,
    primaryEmbedded: false,
    imported: false,
  };
  if (!privyConfigured() || !user.privyUserId) return fallback;
  try {
    const pu: any = await getPrivy().users()._get(user.privyUserId);
    const acc = (pu?.linked_accounts ?? []).find(
      (a: any) => a.type === "wallet" && a.wallet_client_type === "privy" && String(a.address).toLowerCase() === w.address.toLowerCase(),
    );
    if (!acc) return fallback;
    return {
      id: acc.id ?? fallback.id,
      primaryEmbedded: !acc.imported && Number(acc.wallet_index ?? 0) === 0,
      imported: Boolean(acc.imported),
    };
  } catch (e: any) {
    log.warn("privy user lookup failed", redactString(String(e?.message ?? e)));
    return fallback;
  }
}

export async function checkWalletRemoval(user: AppUser, walletId: string): Promise<RemovalCheck & { privy: PrivyWalletInfo }> {
  const w = await getWallet(user.id, walletId, { includeRemoved: true });
  const [balances, privy, nfts, held] = await Promise.all([
    nativeBalances(w.address),
    privyInfo(user, w),
    getDb()
      .select()
      .from(minted)
      .where(and(eq(minted.userId, user.id), eq(minted.wallet, w.address))),
    cachedNftCount(user.id, w.id).catch(() => ({ total: 0, byChain: [], scanned: false })),
  ]);
  const d = decideRemoval({ balances, mintedNfts: nfts.length, privy, privyAvailable: privyConfigured(), heldNfts: held });
  return { walletId: w.id, label: w.label, address: w.address, balances, mintedNfts: nfts.length, heldNfts: held.total, ...d, privy };
}

export type RemovalResult = {
  result: "deleted" | "hidden";
  archivedInPrivy: boolean;
  cancelledJobs: number;
  trimmedJobs: number;
  message: string;
};

export async function removeWalletForUser(user: AppUser, walletId: string, mode: "delete" | "hide"): Promise<RemovalResult> {
  if (mode === "hide") {
    const j = await hideWallet(user.id, walletId);
    return { result: "hidden", archivedInPrivy: false, ...j, message: hiddenMsg(j) };
  }
  const chk = await checkWalletRemoval(user, walletId);
  if (!chk.canDelete) {
    const where = chk.funded.map((f) => `${f.balance} ${f.symbol} on ${f.chainName}`).join(", ");
    throw Object.assign(
      new Error(
        chk.funded.length
          ? `This wallet still holds ${where}. Withdraw first, or hide it instead.`
          : chk.notes.filter((n) => !n.startsWith("Tokens")).join(" ") || "This wallet can't be deleted right now.",
      ),
      { statusCode: 409, code: "WALLET_NOT_EMPTY", details: { funded: chk.funded, unchecked: chk.unchecked, mintedNfts: chk.mintedNfts } },
    );
  }
  if (chk.deleteMode === "hide_only") {
    const j = await hideWallet(user.id, walletId);
    return { result: "hidden", archivedInPrivy: false, ...j, message: `${chk.notes[1]} ${hiddenMsg(j)}`.trim() };
  }
  let archived = false;
  if (chk.deleteMode === "archive_and_delete" && chk.privy.id) {
    try {
      // Privy rejects the archive call without a JSON body (415 "Expected application/json request body").
      await (getPrivy().wallets() as any).archive(chk.privy.id, { body: {} });
      archived = true;
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      if (status === 404)
        archived = true; // already archived / gone in Privy
      else {
        log.warn("privy archive failed", redactString(String(e?.message ?? e)));
        const j = await hideWallet(user.id, walletId);
        return {
          result: "hidden",
          archivedInPrivy: false,
          ...j,
          message: `Privy didn't allow deleting this wallet, so it was hidden from SkyBOT instead. ${hiddenMsg(j)}`.trim(),
        };
      }
    }
  }
  const j = await hardDeleteWallet(user.id, walletId);
  return {
    result: "deleted",
    archivedInPrivy: archived,
    ...j,
    message: `${archived ? "Wallet deleted from SkyBOT and archived in Privy." : "Wallet deleted from SkyBOT."}${jobsMsg(j)}`,
  };
}

function jobsMsg(j: { cancelledJobs: number; trimmedJobs: number }) {
  const parts: string[] = [];
  if (j.cancelledJobs) parts.push(`${j.cancelledJobs} scheduled mint(s) cancelled`);
  if (j.trimmedJobs) parts.push(`removed from ${j.trimmedJobs} scheduled mint(s)`);
  return parts.length ? ` ${parts.join("; ")}.` : "";
}
function hiddenMsg(j: { cancelledJobs: number; trimmedJobs: number }) {
  return `Wallet hidden. Funds stay in the wallet; restore it any time under Removed wallets.${jobsMsg(j)}`;
}
