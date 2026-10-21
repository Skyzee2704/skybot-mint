// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSea read-only session per wallet:
 *  - stores the short-lived read:eligibility JWT in the DB (AES-256-GCM, key derived from the Privy app secret),
 *    so repeat checks on any drop don't ask the wallet to sign again;
 *  - optional server signer (Telegram /check): Privy key quorum added to the wallet with a personal_sign-only
 *    policy. The message is validated by the SIWE guard BEFORE any signature is requested.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { env, privySiweSignerReady } from "../../config/env.js";
import { getDb } from "../../db/client.js";
import { openseaTokens } from "../../db/schema.js";
import { log, redactString } from "../../util/log.js";
import { assertFieldsMatch } from "./siweGuard.js";
import { cachedJwt, jwtFromSignature, prepareSiwe } from "./openseaAuth.js";

function key(): Buffer | null {
  const secret = env.privyAppSecret;
  return secret ? createHash("sha256").update(`skybot:opensea-token:v1:${secret}`).digest() : null;
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
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(jwt, "utf8"), c.final()]);
  const blob = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  const id = address.toLowerCase();
  const exp = new Date(jwtExp(jwt)).toISOString();
  try {
    await getDb()
      .insert(openseaTokens)
      .values({ id, userId, tokenEnc: blob, expiresAt: exp })
      .onConflictDoUpdate({ target: openseaTokens.id, set: { userId, tokenEnc: blob, expiresAt: exp } });
  } catch (e: any) {
    log.warn("opensea token store failed", redactString(String(e?.message ?? e)));
  }
}

/** A valid JWT for this wallet from memory or the DB (only for the same SkyBOT user). */
export async function loadJwt(userId: string, address: string): Promise<string | null> {
  const mem = cachedJwt(address);
  if (mem) return mem;
  const k = key();
  if (!k) return null;
  try {
    const r = (await getDb().select().from(openseaTokens).where(eq(openseaTokens.id, address.toLowerCase())).limit(1))[0];
    if (!r || r.userId !== userId || Date.parse(r.expiresAt) - Date.now() < 5 * 60_000) return null;
    const b = Buffer.from(r.tokenEnc, "base64");
    const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Sign OpenSea's login on the server through the sign-in-only Privy signer. Returns null when the signer isn't
 * configured, the wallet id is unknown, or Privy refuses (signer not added to this wallet yet).
 */
export async function serverSignIn(userId: string, wallet: { address: string; privyWalletId: string | null }): Promise<string | null> {
  if (!privySiweSignerReady() || !wallet.privyWalletId || /^0x/i.test(wallet.privyWalletId)) return null;
  try {
    const msg = await prepareSiwe(wallet.address);
    // Mandatory guard: only OpenSea's exact SIWE text for this wallet, fresh nonce/issuedAt.
    assertFieldsMatch(msg.text, msg.fields, wallet.address);
    const { getPrivy } = await import("../../auth/privy.js");
    const r: any = await getPrivy()
      .wallets()
      .ethereum()
      .signMessage(wallet.privyWalletId, {
        message: msg.text,
        authorization_context: { authorization_private_keys: [env.privySiweAuthPrivateKey!] },
      } as any);
    const signature = r?.signature ?? r?.data?.signature;
    if (typeof signature !== "string") return null;
    const jwt = await jwtFromSignature(msg.fields, signature);
    await storeJwt(userId, wallet.address, jwt);
    return jwt;
  } catch (e: any) {
    log.warn("opensea server sign-in skipped", redactString(String(e?.message ?? e)).slice(0, 160));
    return null;
  }
}
