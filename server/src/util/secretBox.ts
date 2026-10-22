// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AES-256-GCM sealing for small secrets stored in the DB (e.g. Alchemy webhook signing keys).
 * Key = purpose-bound HMAC derivation of SESSION_SECRET (derivedKey), so a DB dump alone can't reveal them.
 * Format: base64(iv[12] | tag[16] | ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { derivedKey } from "../auth/session.js";

export function seal(purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derivedKey(`secret-box:${purpose}`), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

/** null when the blob is malformed or was sealed with another key. */
export function open(purpose: string, blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    const b = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", derivedKey(`secret-box:${purpose}`), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
