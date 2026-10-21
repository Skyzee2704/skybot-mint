import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { EncBlob, KeystoreMeta } from "../store.js";

/**
 * Keys at rest: AES-256-GCM, one random 96-bit IV per key, AAD = lowercase wallet address
 * (binds ciphertext to its address). The 256-bit KEK is derived from the master password
 * with scrypt (N configurable, r=8, p=1). A verifier blob detects a wrong password.
 */
const VERIFIER_PLAINTEXT = "nft-mint-bot:keystore-verifier:v1";

export function deriveKek(password: string, salt: Buffer, N: number, r = 8, p = 1): Buffer {
  if (!password || password.length < 8) throw new Error("Master password must be at least 8 characters");
  return scryptSync(password.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

export function encrypt(kek: Buffer, plaintext: string, aad: string): EncBlob {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function decrypt(kek: Buffer, blob: EncBlob, aad: string): string {
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(blob.iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8");
}

export function createKeystoreMeta(password: string, N: number): { meta: KeystoreMeta; kek: Buffer } {
  const salt = randomBytes(16);
  const kek = deriveKek(password, salt, N);
  return {
    meta: { version: 1, kdf: "scrypt", salt: salt.toString("base64"), N, r: 8, p: 1, verifier: encrypt(kek, VERIFIER_PLAINTEXT, "verifier") },
    kek,
  };
}

/** Returns the KEK if the password is right, otherwise throws. */
export function unlockKeystore(meta: KeystoreMeta, password: string): Buffer {
  const kek = deriveKek(password, Buffer.from(meta.salt, "base64"), meta.N, meta.r, meta.p);
  let ok = false;
  try {
    const v = decrypt(kek, meta.verifier, "verifier");
    ok = timingSafeEqual(Buffer.from(v), Buffer.from(VERIFIER_PLAINTEXT));
  } catch { ok = false; }
  if (!ok) { kek.fill(0); throw Object.assign(new Error("Wrong master password"), { statusCode: 401 }); }
  return kek;
}
