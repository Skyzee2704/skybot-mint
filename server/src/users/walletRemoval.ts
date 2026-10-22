// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wallet removal.
 * - "delete": the strongest removal Privy supports (verified 2026-10-22 against the live API):
 *   POST /v1/wallets/{id}/archive (no DELETE endpoint exists; embedded and imported wallets can't be unlinked from
 *   the Privy user — unlink returns 400 linked_account_not_found), then our row is deleted and a tombstone stops
 *   Privy sync from re-adding it. A wallet that still holds funds / NFTs needs explicit confirmation (the member
 *   ticks the acknowledgement checkbox).
 *   The user's primary embedded wallet (wallet_index 0, not imported) anchors Privy's HD wallets: never archived.
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
import { getWallet, hardDeleteWallet, hideWallet, listWallets, setMain, type AppUser } from "./service.js";

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
  /** Empty everywhere we can check (no confirmation needed). */
  canDelete: boolean;
  /** Funds / NFTs present or a balance unreadable: removal needs the acknowledgement checkbox. */
  requiresConfirmation: boolean;
  walletKind: "imported" | "created" | "primary" | "unknown";
  /** Kind-specific consequences, shown prominently. */
  warnings: string[];
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
}): Pick<
  RemovalCheck,
  "funded" | "unchecked" | "canDelete" | "deleteMode" | "notes" | "primaryEmbedded" | "requiresConfirmation" | "walletKind" | "warnings"
> {
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
    notes.push(
      "This is your primary Privy wallet: Privy derives your other created wallets from it, so SkyBOT only hides it (it stays usable, and you can restore it here).",
    );
  } else if (input.privy.id && input.privyAvailable) deleteMode = "archive_and_delete";
  else {
    deleteMode = "delete_local";
    notes.push("Privy wallet id unknown, so the wallet is removed from SkyBOT only and stays in your Privy account.");
  }
  if (unchecked.length) notes.push(`Couldn't read the balance on ${unchecked.map((u) => u.chainName).join(", ")}. Treat it as possibly funded.`);
  if (held)
    notes.push(
      `The last holdings scan shows ${held} NFT(s) in this wallet (${input.heldNfts!.byChain.map((c) => `${c.count} on ${c.chain}`).join(", ")}).`,
    );
  if (input.mintedNfts) notes.push(`This wallet minted ${input.mintedNfts} NFT(s) with SkyBOT.`);
  const walletKind: RemovalCheck["walletKind"] = input.privy.primaryEmbedded
    ? "primary"
    : input.privy.imported
      ? "imported"
      : input.privy.id
        ? "created"
        : "unknown";
  const warnings: string[] = [];
  if (deleteMode === "archive_and_delete") {
    warnings.push(
      "Removing archives the wallet in Privy: it can no longer sign, send or be exported, and SkyBOT will never show it again. Privy offers no full delete; the address keeps receiving funds, and only Privy support can restore an archived wallet.",
    );
    if (walletKind === "imported")
      warnings.push("This wallet was imported, so you can keep using it anywhere (for example MetaMask) with your own copy of its private key.");
    else
      warnings.push(
        "This wallet was created by Privy and its key exists nowhere else. Unless you export the private key first, anything left in it may be unrecoverable.",
      );
  }
  const requiresConfirmation = !canDelete && deleteMode !== "hide_only";
  return { funded, unchecked, canDelete, deleteMode, notes, primaryEmbedded: input.privy.primaryEmbedded, requiresConfirmation, walletKind, warnings };
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
  /** Label of the wallet that became Main, when the removed wallet was Main. */
  newMain: string | null;
  cancelledJobs: number;
  trimmedJobs: number;
  message: string;
};

export interface RemovalOptions {
  /** Ticked "I understand…" (required when the wallet holds funds / NFTs or a balance couldn't be read). */
  acknowledge?: boolean;
  /** Legacy: the wallet's name typed by older clients. Accepted and ignored; the checkbox alone confirms. */
  confirmLabel?: string;
  /** Removing the Main wallet: which wallet becomes Main (default: the oldest remaining). */
  newMainId?: string;
}

/** The member's explicit go-ahead for removing a wallet that still holds something. Pure (tested). */
export function confirmationProblem(chk: Pick<RemovalCheck, "requiresConfirmation" | "label">, o: RemovalOptions): string | null {
  if (!chk.requiresConfirmation) return null;
  if (o.acknowledge !== true) return "Tick the confirmation to remove a wallet that may still hold funds or NFTs.";
  return null;
}

async function handOverMain(user: AppUser, walletId: string, newMainId?: string) {
  const w = await getWallet(user.id, walletId, { includeRemoved: true });
  if (!w.isMain) return null;
  const rest = (await listWallets(user.id)).filter((x) => x.id !== walletId);
  if (!rest.length) return null;
  const pick = newMainId ? rest.find((x) => x.id === newMainId) : rest[0];
  if (newMainId && !pick) throw Object.assign(new Error("Choose one of your other wallets as the new Main."), { statusCode: 400 });
  await setMain(user.id, pick!.id);
  return pick!.label;
}

export async function removeWalletForUser(
  user: AppUser,
  walletId: string,
  mode: "delete" | "hide",
  opts: RemovalOptions = {},
): Promise<RemovalResult> {
  if (mode === "hide") {
    const nm = await handOverMain(user, walletId, opts.newMainId);
    const j = await hideWallet(user.id, walletId);
    return { result: "hidden", archivedInPrivy: false, newMain: nm, ...j, message: `${hiddenMsg(j)}${mainMsg(nm)}` };
  }
  const chk = await checkWalletRemoval(user, walletId);
  const problem = chk.deleteMode === "hide_only" ? null : confirmationProblem(chk, opts);
  if (problem)
    throw Object.assign(new Error(problem), {
      statusCode: 409,
      code: "CONFIRMATION_REQUIRED",
      details: { funded: chk.funded, unchecked: chk.unchecked, mintedNfts: chk.mintedNfts, heldNfts: chk.heldNfts ?? 0 },
    });
  const nm = await handOverMain(user, walletId, opts.newMainId);
  if (chk.deleteMode === "hide_only") {
    const j = await hideWallet(user.id, walletId);
    return { result: "hidden", archivedInPrivy: false, newMain: nm, ...j, message: `${chk.notes[1]} ${hiddenMsg(j)}${mainMsg(nm)}`.trim() };
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
          newMain: nm,
          ...j,
          message: `Privy didn't allow archiving this wallet, so it was hidden from SkyBOT instead. ${hiddenMsg(j)}${mainMsg(nm)}`.trim(),
        };
      }
    }
  }
  const j = await hardDeleteWallet(user.id, walletId);
  return {
    result: "deleted",
    archivedInPrivy: archived,
    newMain: nm,
    ...j,
    message: `${archived ? "Wallet removed from SkyBOT and archived in Privy (it can no longer sign)." : "Wallet removed from SkyBOT."}${jobsMsg(j)}${mainMsg(nm)}`,
  };
}

function jobsMsg(j: { cancelledJobs: number; trimmedJobs: number }) {
  const parts: string[] = [];
  if (j.cancelledJobs) parts.push(`${j.cancelledJobs} scheduled mint(s) cancelled`);
  if (j.trimmedJobs) parts.push(`removed from ${j.trimmedJobs} scheduled mint(s)`);
  return parts.length ? ` ${parts.join("; ")}.` : "";
}
function mainMsg(nm: string | null) {
  return nm ? ` ${nm} is now your Main wallet.` : "";
}
function hiddenMsg(j: { cancelledJobs: number; trimmedJobs: number }) {
  return `Wallet hidden. Funds stay in the wallet; restore it any time under Removed wallets.${jobsMsg(j)}`;
}
