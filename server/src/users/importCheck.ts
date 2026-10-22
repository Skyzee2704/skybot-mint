// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pre-import check for "Import Private Key".
 *
 * Privy rejects importing a private key whose address already exists in this Privy app, and that includes
 * wallets archived by SkyBOT's Remove flow (Privy: "Address preserved … your app cannot reuse it"). The raw Privy
 * error ("wallet already exists") doesn't say why, so the browser asks here first.
 *
 * The browser proves it holds the key by signing a short message locally (the key never leaves the browser);
 * only then does SkyBOT reveal what Privy has on record for that address. No proof, no answer: nobody can probe
 * other members' addresses.
 */
import { getAddress, verifyMessage } from "ethers";
import { privyWalletByAddress, privyWalletOriginByAddress } from "../auth/privy.js";

export const IMPORT_CHECK_TITLE = "SkyBOT Mint import check";
/** How long a signed check stays valid (clock skew included). */
export const IMPORT_CHECK_MAX_AGE_MS = 10 * 60_000;

/** Must stay byte-identical to web/lib/importCheck.ts. */
export function importCheckMessage(address: string, issuedAt: string): string {
  return `${IMPORT_CHECK_TITLE}\nAddress: ${getAddress(address)}\nIssued: ${issuedAt}\n\nThis proves you hold this wallet's private key. It is not a transaction and costs nothing.`;
}

const bad = (m: string) => Object.assign(new Error(m), { statusCode: 400, code: "IMPORT_CHECK_INVALID" });

/** Returns the checksummed address when the signature was made by that address's key within the time window. */
export function verifyImportProof(input: { address: string; issuedAt: string; signature: string }, nowMs = Date.now()): string {
  let address: string;
  try {
    address = getAddress(input.address);
  } catch {
    throw bad("Invalid wallet address.");
  }
  const t = Date.parse(input.issuedAt);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > IMPORT_CHECK_MAX_AGE_MS) throw bad("The import check expired. Try again.");
  let signer: string;
  try {
    signer = verifyMessage(importCheckMessage(address, input.issuedAt), input.signature);
  } catch {
    throw bad("The import check signature is invalid.");
  }
  if (signer !== address) throw bad("The import check signature doesn't match this wallet.");
  return address;
}

export type ImportCheckStatus =
  /** Not in Privy yet: import normally. */
  | "available"
  /** Already an active wallet of this Privy user: add it back to SkyBOT without importing. */
  | "in_your_account"
  /** Active in another Privy user of this app. */
  | "other_account"
  /** Archived (removed) in this Privy user. */
  | "archived_yours"
  /** Archived (removed) in another Privy user, or owner unknown. */
  | "archived_other"
  /** Privy couldn't be asked: fall back to a normal import. */
  | "unknown";

export interface ImportCheckResult {
  status: ImportCheckStatus;
  address: string;
  privyWalletId?: string;
  message?: string;
}

const RESERVED =
  "Removing a wallet archives it in Privy, and Privy keeps an archived address reserved: the same private key can't be imported again into any SkyBOT Mint account.";
const SAFE = "Funds at this address are not affected: the private key still controls them in any other wallet app (for example MetaMask).";
const RESTORE =
  "To use it in SkyBOT Mint again, the app admin has to ask Privy support to restore the wallet; a restored wallet returns to the account it was removed from.";

export const IMPORT_CHECK_MESSAGES = {
  archived_yours: `You removed this wallet from this account earlier. ${RESERVED} ${SAFE} ${RESTORE}`,
  archived_other: `This wallet was removed from another SkyBOT Mint account. ${RESERVED} ${SAFE} ${RESTORE}`,
  other_account:
    "This wallet is already active in another SkyBOT Mint account, and Privy allows each address in only one account. Sign in with that account to use it.",
} as const;

type Lookup = typeof privyWalletByAddress;
type Mine = typeof privyWalletOriginByAddress;

export function classifyImport(
  address: string,
  rec: Awaited<ReturnType<Lookup>>,
  privyUserId: string | null,
  linkedToMe: { id: string } | null,
): ImportCheckResult {
  if (!rec) return { status: "unknown", address };
  if (!rec.found) return { status: "available", address };
  const mine = Boolean(privyUserId && rec.ownerPrivyUserId && rec.ownerPrivyUserId === privyUserId);
  if (rec.archived) {
    const status = mine ? "archived_yours" : "archived_other";
    return { status, address, message: IMPORT_CHECK_MESSAGES[status] };
  }
  if (mine || linkedToMe) return { status: "in_your_account", address, privyWalletId: linkedToMe?.id ?? rec.id };
  // Active, owner not resolvable from the record and not in this user's linked accounts: someone else's.
  return { status: "other_account", address, message: IMPORT_CHECK_MESSAGES.other_account };
}

export async function importPreflight(
  privyUserId: string | null,
  input: { address: string; issuedAt: string; signature: string },
  deps: { lookup?: Lookup; mine?: Mine; nowMs?: number } = {},
): Promise<ImportCheckResult> {
  const address = verifyImportProof(input, deps.nowMs);
  const pid = privyUserId && !privyUserId.startsWith("tg:") ? privyUserId : null;
  const rec = await (deps.lookup ?? privyWalletByAddress)(address);
  const linked = rec?.found && !rec.archived && pid ? await (deps.mine ?? privyWalletOriginByAddress)(pid, address) : null;
  return classifyImport(address, rec, pid, linked ? { id: linked.id } : null);
}
