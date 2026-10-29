// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mint signer: scheduled / server-run mints are signed by Privy with the app authorization key
 * (PRIVY_AUTH_PRIVATE_KEY), which Privy only honours on a wallet whose owner is the app key quorum
 * (PRIVY_AUTH_KEY_QUORUM_ID) or that lists the quorum as an additional signer. Member wallets are user-owned, so —
 * exactly like the sign-in-only signer (siweSigner.ts) — only the member's own app session can add it: the server
 * reports which wallets miss it, the app adds those silently (optionally with PRIVY_MINT_POLICY_ID), then the
 * server re-verifies with Privy. Jobs check the same thing before they are accepted and again before signing, so a
 * wallet that can't be signed for fails with a clear reason instead of a generic error.
 */
import { and, eq, isNull } from "drizzle-orm";
import { env, privyConfigured, privyServerSigningReady } from "../config/env.js";
import { getDb } from "../db/client.js";
import { mintSigners, wallets } from "../db/schema.js";
import { log, redactString } from "../util/log.js";
import { looksLikePrivyWalletId, privyWalletIds, resolvePrivyWalletId } from "./siweSigner.js";

export const SIGNING_OFF_MESSAGE =
  "Automatic minting is switched off on the server (Privy signing key not configured), so nothing was signed or sent and no gas was spent.";

export const signerMissingMessage = (address: string) =>
  `Automatic minting isn't enabled yet for wallet ${address}: Privy only lets SkyBOT sign for it after the wallet ` +
  `owner adds the SkyBOT mint signer. Open the SkyBOT app once while signed in (it adds it automatically), then ` +
  `create the job again. Nothing was sent; no gas was spent.`;

/** The member's app can add the mint signer (public ids only). */
export function mintSignerReady() {
  return privyServerSigningReady() && Boolean(env.privyAuthKeyQuorumId);
}

/** Can the app key sign for this Privy wallet record? */
export function walletHasMintSigner(w: any, quorum = env.privyAuthKeyQuorumId): boolean {
  if (!w || !quorum) return false;
  return w.owner_id === quorum || (w.additional_signers ?? []).some((s: any) => s?.signer_id === quorum);
}

const iso = () => new Date().toISOString();
async function mark(walletId: string, attached: boolean, note: string | null) {
  const at = iso();
  const v = { walletId, attachedAt: attached ? at : null, checkedAt: at, note };
  await getDb()
    .insert(mintSigners)
    .values(v)
    .onConflictDoUpdate({ target: mintSigners.walletId, set: { attachedAt: v.attachedAt, checkedAt: at, note } });
}

type WalletLite = { id: string; userId: string; address: string; privyWalletId: string | null };
export type MintSignerState = "attached" | "missing" | "no_privy_wallet" | "unknown";

/** Live Privy check for one wallet (records the result). Lookup errors are "unknown" — never block on them. */
export async function checkMintSigner(w: WalletLite, privyUserId?: string | null): Promise<MintSignerState> {
  if (!mintSignerReady()) return "unknown";
  try {
    const id = await resolvePrivyWalletId(w, privyUserId);
    if (!id) {
      await mark(w.id, false, "not a Privy embedded wallet");
      return "no_privy_wallet";
    }
    const { getPrivy } = await import("../auth/privy.js");
    const pw: any = await getPrivy().wallets().get(id);
    const ok = walletHasMintSigner(pw);
    await mark(w.id, ok, ok ? null : "added by the member's app");
    return ok ? "attached" : "missing";
  } catch (e: any) {
    log.warn("mint signer check failed", redactString(String(e?.message ?? e)).slice(0, 160));
    return "unknown";
  }
}

export interface MintSignerReport {
  attachedAddresses: string[];
  missingAddresses: string[];
}

/** Status of every active wallet of a member (for the app's silent attach). Attached wallets are not re-read. */
export async function mintSignerStatus(user: { id: string; privyUserId: string | null }): Promise<MintSignerReport> {
  const out: MintSignerReport = { attachedAddresses: [], missingAddresses: [] };
  if (!mintSignerReady() || !privyConfigured() || !user.privyUserId || user.privyUserId.startsWith("tg:")) return out;
  const db = getDb();
  const ws = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, user.id), isNull(wallets.removedAt)));
  const known = new Map((await db.select().from(mintSigners)).map((s) => [s.walletId, s]));
  let ids: Map<string, string> | null = null;
  for (const w of ws) {
    if (known.get(w.id)?.attachedAt) {
      out.attachedAddresses.push(w.address);
      continue;
    }
    let row = w as WalletLite;
    if (!looksLikePrivyWalletId(w.privyWalletId)) {
      ids ??= await privyWalletIds(user.privyUserId).catch(() => new Map<string, string>());
      row = { ...w, privyWalletId: ids.get(w.address.toLowerCase()) ?? w.privyWalletId };
    }
    const st = await checkMintSigner(row, user.privyUserId);
    (st === "attached" ? out.attachedAddresses : out.missingAddresses).push(w.address);
  }
  return out;
}

/**
 * Before a job is accepted (and again before it signs): the wallets Privy would refuse to sign for.
 * Returns null when everything is fine or can't be determined (lookup errors never block a mint).
 */
export async function mintSigningProblem(
  ws: WalletLite[],
  privyUserId?: string | null,
): Promise<{ message: string; missing: string[] } | null> {
  if (!privyServerSigningReady()) return { message: SIGNING_OFF_MESSAGE, missing: [] };
  if (!mintSignerReady()) return null;
  const missing: string[] = [];
  for (const w of ws) if ((await checkMintSigner(w, privyUserId)) === "missing") missing.push(w.address);
  if (!missing.length) return null;
  return {
    missing,
    message:
      missing.length === 1
        ? signerMissingMessage(missing[0]!)
        : `Automatic minting isn't enabled yet for ${missing.length} wallets (${missing.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(", ")}): ` +
          `Privy only lets SkyBOT sign for them after the wallet owner adds the SkyBOT mint signer. Open the SkyBOT app once ` +
          `while signed in (it adds it automatically), then create the job again. Nothing was sent; no gas was spent.`,
  };
}

/** Plain-English reason when Privy refuses to sign (authorization / policy), else null. */
export function privySigningRefusal(e: any, address: string): string | null {
  const status = Number(e?.status ?? e?.statusCode ?? e?.response?.status ?? NaN);
  const m = String(e?.message ?? e ?? "");
  if (/invalid private key|not valid base64|PKCS#8|pkcs8/i.test(m))
    return "Automatic minting is misconfigured on the server (the Privy signing key can't be read), so nothing was sent.";
  if (/policy/i.test(m) && /(den|violat|not allowed|reject)/i.test(m))
    return `Privy's policy for the SkyBOT mint signer refused this transaction for ${address}, so nothing was sent.`;
  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|authorization signature|no valid authorization|not authorized|missing.*signer|signer.*(not|missing)/i.test(m)
  )
    return signerMissingMessage(address);
  return null;
}

let diagCache: { at: number; v: MintSignerDiag } | null = null;
export interface MintSignerDiag {
  /** PRIVY_AUTH_PRIVATE_KEY parses as a P-256 key. */
  keyReadable: boolean;
  quorumConfigured: boolean;
  /** The key's public half is a member of PRIVY_AUTH_KEY_QUORUM_ID (null = couldn't ask Privy). */
  keyInQuorum: boolean | null;
}

/** Booleans only (no ids or keys) for /api/status; cached 10 min. */
export async function mintSignerDiag(): Promise<MintSignerDiag | null> {
  if (!privyServerSigningReady()) return null;
  if (diagCache && Date.now() - diagCache.at < 600_000) return diagCache.v;
  const { authPublicKey, samePublicKey } = await import("../auth/authKey.js");
  const pub = authPublicKey(env.privyAuthPrivateKey);
  const v: MintSignerDiag = { keyReadable: Boolean(pub), quorumConfigured: Boolean(env.privyAuthKeyQuorumId), keyInQuorum: null };
  if (pub && env.privyAuthKeyQuorumId) {
    try {
      const { getPrivy } = await import("../auth/privy.js");
      const q: any = await getPrivy().keyQuorums().get(env.privyAuthKeyQuorumId);
      v.keyInQuorum = (q?.authorization_keys ?? []).some((k: any) => samePublicKey(k?.public_key, pub));
    } catch (e: any) {
      log.warn("mint signer diag", redactString(String(e?.message ?? e)).slice(0, 160));
    }
  }
  diagCache = { at: Date.now(), v };
  return v;
}
