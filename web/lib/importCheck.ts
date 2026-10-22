// SPDX-License-Identifier: AGPL-3.0-only
// Pre-import check: the private key signs a short message right here in the browser (it is never sent anywhere
// except to Privy's own import), so SkyBOT can say what Privy has on record for the address before importing.
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const IMPORT_CHECK_TITLE = "SkyBOT Mint import check";

/** Must stay byte-identical to server/src/users/importCheck.ts. */
export function importCheckMessage(address: string, issuedAt: string): string {
  return `${IMPORT_CHECK_TITLE}\nAddress: ${getAddress(address)}\nIssued: ${issuedAt}\n\nThis proves you hold this wallet's private key. It is not a transaction and costs nothing.`;
}

/** Normalizes a pasted EVM private key (whitespace, optional 0x) or throws a readable error. */
export function normalizePrivateKey(raw: string): `0x${string}` {
  const k = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(k))
    throw new Error("That doesn't look like an EVM private key (64 hexadecimal characters, with or without 0x).");
  return `0x${k}`;
}

export async function signImportCheck(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({ message: importCheckMessage(account.address, issuedAt) });
  return { address: account.address, issuedAt, signature };
}

/** Privy's raw import error when the address already exists in this app (often archived by an earlier Remove). */
export function explainImportError(e: any): string {
  const m = String(e?.message ?? e ?? "");
  if (/already (exists|imported)|resource_already_exists|wallet.*exist/i.test(m))
    return "Privy already has a wallet with this address in SkyBOT Mint (for example one removed earlier, which Privy keeps archived), so it can't be imported again.";
  return m || "Import failed.";
}
