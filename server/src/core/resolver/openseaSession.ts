// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSea read-only session per wallet, built so a member never has to open the app because something expired.
 *
 * What expires (OpenSea docs › Authentication › Token lifecycle, and measured):
 *  - wallet JWT: `expiresIn` 3599 s (measured 2026-10-22; docs say "about 12 hours") → re-minted from the PAT;
 *  - scoped PAT (read:eligibility only): lifetime set at creation; we ask for 90 days (365 is refused) and
 *    re-sign through the server signer when it is near expiry, revoked or rejected;
 *  - the SIWE message itself carries no Expiration Time (OpenSea rejects the optional fields); its nonce is single-use.
 *
 * Order for every check: valid JWT (memory/DB) → exchange the stored PAT (1 request, no signature) → fresh SIWE
 * via the sign-in-only Privy signer (message validated by the SIWE guard BEFORE any signature is requested).
 * Tokens are stored AES-256-GCM encrypted (key derived from the Privy app secret) and never logged.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { env, privySiweSignerReady } from "../../config/env.js";
import { getDb } from "../../db/client.js";
import { openseaPats, openseaTokens } from "../../db/schema.js";
import { log, redactString } from "../../util/log.js";
import { assertFieldsMatch } from "./siweGuard.js";
import {
  OpenSeaHttpError,
  cachedJwt,
  eligibilityWithJwt,
  exchangePat,
  forgetJwt,
  isRateLimited,
  jwtFromSignature,
  prepareSiwe,
  type OpenSeaPat,
} from "./openseaAuth.js";

/** A JWT this close to expiry is treated as expired (never start a check with a token about to die). */
export const JWT_MIN_LEFT_MS = 5 * 60_000;
/** A PAT this close to expiry is renewed by a fresh server sign-in while it still works as a fallback. */
export const PAT_RENEW_BEFORE_MS = 7 * 86_400_000;

function key(): Buffer | null {
  const secret = env.privyAppSecret;
  return secret ? createHash("sha256").update(`skybot:opensea-token:v1:${secret}`).digest() : null;
}

function seal(k: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function open(k: Buffer, blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export function jwtExp(jwt: string): number {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof p.exp === "number" ? p.exp * 1000 : Date.now() + 3600_000;
  } catch {
    return Date.now() + 3600_000;
  }
}

export async function storeJwt(userId: string, address: string, jwt: string) {
  const k = key();
  if (!k) return;
  const id = address.toLowerCase();
  const exp = new Date(jwtExp(jwt)).toISOString();
  const tokenEnc = seal(k, jwt);
  try {
    await getDb()
      .insert(openseaTokens)
      .values({ id, userId, tokenEnc, expiresAt: exp })
      .onConflictDoUpdate({ target: openseaTokens.id, set: { userId, tokenEnc, expiresAt: exp } });
  } catch (e: any) {
    log.warn("opensea token store failed", redactString(String(e?.message ?? e)));
  }
}

/** A valid JWT for this wallet from memory or the DB (only for the same SkyBOT user), with ≥ 5 min left. */
export async function loadJwt(userId: string, address: string): Promise<string | null> {
  const mem = cachedJwt(address);
  if (mem) return mem;
  const k = key();
  if (!k) return null;
  try {
    const r = (await getDb().select().from(openseaTokens).where(eq(openseaTokens.id, address.toLowerCase())).limit(1))[0];
    if (!r || r.userId !== userId || Date.parse(r.expiresAt) - Date.now() < JWT_MIN_LEFT_MS) return null;
    return open(k, r.tokenEnc);
  } catch {
    return null;
  }
}

/** OpenSea refused this JWT (401/403): forget it everywhere so the next step re-mints one. */
export async function dropJwt(address: string) {
  forgetJwt(address);
  await getDb()
    .delete(openseaTokens)
    .where(eq(openseaTokens.id, address.toLowerCase()))
    .catch(() => {});
}

export async function storePat(userId: string, address: string, pat: OpenSeaPat) {
  const k = key();
  if (!k) return;
  const id = address.toLowerCase();
  const patEnc = seal(k, JSON.stringify({ id: pat.id, token: pat.token }));
  await getDb()
    .insert(openseaPats)
    .values({ id, userId, patEnc, expiresAt: pat.expiresAt })
    .onConflictDoUpdate({ target: openseaPats.id, set: { userId, patEnc, expiresAt: pat.expiresAt } });
}

export async function loadPat(userId: string, address: string): Promise<OpenSeaPat | null> {
  const k = key();
  if (!k) return null;
  try {
    const r = (await getDb().select().from(openseaPats).where(eq(openseaPats.id, address.toLowerCase())).limit(1))[0];
    if (!r || r.userId !== userId || Date.parse(r.expiresAt) <= Date.now()) return null;
    const p = JSON.parse(open(k, r.patEnc));
    return typeof p?.token === "string" ? { id: String(p.id), token: p.token, expiresAt: r.expiresAt } : null;
  } catch {
    return null;
  }
}

export async function dropPat(address: string) {
  await getDb()
    .delete(openseaPats)
    .where(eq(openseaPats.id, address.toLowerCase()))
    .catch(() => {});
}

/** Keep the PAT from a sign-in (server signer or the member's own browser signature). */
export const patKeeper = (userId: string, address: string) => (pat: OpenSeaPat) =>
  storePat(userId, address, pat).catch((e: any) =>
    log.warn("opensea pat store failed", redactString(String(e?.message ?? e)).slice(0, 120)),
  );

/** Why a wallet could not be signed in to OpenSea from the server (shown per wallet in /check). */
export type SignInFailure =
  /** The sign-in-only signer isn't on this wallet yet (member's app adds it on the next open). */
  | "no_signer"
  /** OpenSea answered 429 even after the bounded retries. */
  | "rate_limited"
  /** Not a Privy embedded wallet (or its Privy id is unknown). */
  | "no_privy_wallet"
  /** Automatic sign-in isn't available here (server signer not configured or not requested). */
  | "not_configured"
  | "error";

export type JwtResult = { jwt: string; via: "cache" | "pat" | "signin"; reason?: undefined } | { jwt: null; reason: SignInFailure };

// One full SIWE sign-in at a time per instance: each is ~5 OpenSea auth requests, and parallel bursts hit 429.
let signInChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = signInChain.then(fn, fn);
  signInChain = run.catch(() => {});
  return run;
}

type Wallet = { id?: string; address: string; privyWalletId: string | null };

/**
 * Sign OpenSea's login on the server through the sign-in-only Privy signer; stores the new JWT and PAT.
 * Never throws: failures come back with a reason.
 */
export async function serverSignInDetailed(userId: string, wallet: Wallet): Promise<JwtResult> {
  if (!privySiweSignerReady()) return { jwt: null, reason: "not_configured" };
  let privyWalletId: string | null = null;
  try {
    // Older rows stored the address instead of the Privy wallet id: resolve (and fix) it first.
    const { resolvePrivyWalletId } = await import("../../users/siweSigner.js");
    privyWalletId = wallet.id
      ? await resolvePrivyWalletId({ id: wallet.id, userId, address: wallet.address, privyWalletId: wallet.privyWalletId })
      : /^0x/i.test(wallet.privyWalletId ?? "0x")
        ? null
        : wallet.privyWalletId;
  } catch {
    privyWalletId = null;
  }
  if (!privyWalletId) return { jwt: null, reason: "no_privy_wallet" };
  return serialized(async () => {
    // Another check may have signed this wallet in while we waited.
    const again = await loadJwt(userId, wallet.address);
    if (again) return { jwt: again, via: "cache" as const };
    let stage: "opensea" | "privy" = "opensea";
    try {
      const msg = await prepareSiwe(wallet.address);
      // Mandatory guard: only OpenSea's exact SIWE text for this wallet, fresh nonce/issuedAt.
      assertFieldsMatch(msg.text, msg.fields, wallet.address);
      stage = "privy";
      const { getPrivy } = await import("../../auth/privy.js");
      const r: any = await getPrivy()
        .wallets()
        .ethereum()
        .signMessage(privyWalletId!, {
          message: msg.text,
          authorization_context: { authorization_private_keys: [env.privySiweAuthPrivateKey!] },
        } as any);
      const signature = r?.signature ?? r?.data?.signature;
      if (typeof signature !== "string") return { jwt: null, reason: "error" as const };
      stage = "opensea";
      const jwt = await jwtFromSignature(msg.fields, signature, fetch, { keepPat: patKeeper(userId, wallet.address) });
      await storeJwt(userId, wallet.address, jwt);
      return { jwt, via: "signin" as const };
    } catch (e: any) {
      log.warn("opensea server sign-in skipped", redactString(String(e?.message ?? e)).slice(0, 160));
      if (isRateLimited(e)) return { jwt: null, reason: "rate_limited" as const };
      if (stage === "privy")
        return { jwt: null, reason: (await signerMissing(privyWalletId!)) ? ("no_signer" as const) : ("error" as const) };
      return { jwt: null, reason: "error" as const };
    }
  });
}

/** True when Privy's record shows the sign-in-only quorum is not on the wallet (read-only lookup). */
async function signerMissing(privyWalletId: string): Promise<boolean> {
  try {
    const { getPrivy } = await import("../../auth/privy.js");
    const w: any = await getPrivy().wallets().get(privyWalletId);
    return !(w?.additional_signers ?? []).some((s: any) => s?.signer_id === env.privySiweKeyQuorumId);
  } catch {
    return false;
  }
}

/** Back-compat: JWT or null. */
export async function serverSignIn(userId: string, wallet: Wallet): Promise<string | null> {
  const r = await serverSignInDetailed(userId, wallet);
  return r.jwt;
}

/**
 * A usable wallet JWT without the member: cached JWT → PAT exchange → server SIWE sign-in.
 * `fresh` skips the cached JWT (OpenSea just rejected it). A PAT near expiry is renewed by a server sign-in while
 * it still works; a revoked/expired PAT (401/403) is dropped and replaced the same way.
 */
export async function walletJwt(userId: string, wallet: Wallet, opts: { serverSign?: boolean; fresh?: boolean } = {}): Promise<JwtResult> {
  if (!opts.fresh) {
    const jwt = await loadJwt(userId, wallet.address);
    if (jwt) return { jwt, via: "cache" };
  }
  let rateLimited = false;
  const pat = await loadPat(userId, wallet.address);
  if (pat) {
    try {
      const jwt = await exchangePat(wallet.address, pat.token);
      // Proactive renewal before the PAT expires (needs the signer); on failure the still-valid PAT's JWT is used.
      if (opts.serverSign && Date.parse(pat.expiresAt) - Date.now() < PAT_RENEW_BEFORE_MS) {
        forgetJwt(wallet.address); // so the sign-in below doesn't short-circuit on this JWT
        const renewed = await serverSignInDetailed(userId, wallet);
        if (renewed.jwt) return renewed;
      }
      await storeJwt(userId, wallet.address, jwt);
      return { jwt, via: "pat" };
    } catch (e: any) {
      if (e instanceof OpenSeaHttpError && (e.status === 401 || e.status === 403)) await dropPat(wallet.address);
      else if (isRateLimited(e)) rateLimited = true;
      else log.warn("opensea pat exchange failed", redactString(String(e?.message ?? e)).slice(0, 160));
    }
  }
  if (!opts.serverSign) return { jwt: null, reason: rateLimited ? "rate_limited" : "not_configured" };
  const r = await serverSignInDetailed(userId, wallet);
  if (!r.jwt && rateLimited && r.reason === "error") return { jwt: null, reason: "rate_limited" };
  return r;
}

/**
 * OpenSea drop eligibility with a session that may have expired or been revoked server-side: on 401/403 the JWT
 * is dropped, a new one is obtained silently (PAT exchange, then server sign-in) and the request is retried once.
 * When re-auth fails the error carries `signInReason`.
 */
export async function eligibilityWithReauth(
  userId: string,
  wallet: Wallet,
  jwt: string,
  slug: string,
  opts: { serverSign?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
) {
  try {
    return await eligibilityWithJwt(jwt, slug, fetchImpl);
  } catch (e) {
    if (!(e instanceof OpenSeaHttpError && (e.status === 401 || e.status === 403))) throw e;
    await dropJwt(wallet.address);
    const again = await walletJwt(userId, wallet, { serverSign: opts.serverSign, fresh: true });
    if (!again.jwt) throw Object.assign(e, { signInReason: again.reason });
    return eligibilityWithJwt(again.jwt, slug, fetchImpl);
  }
}
