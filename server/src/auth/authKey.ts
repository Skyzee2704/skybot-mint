// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Privy authorization keys. Privy's SDK only accepts a bare base64 PKCS#8 P-256 key (optionally "wallet-auth:"-prefixed);
 * a PEM pasted into Vercel (headers, line breaks, SEC1 "EC PRIVATE KEY", or base64 of the whole PEM) makes every
 * signing call throw. These helpers normalize the key and derive its public key so /api/status can confirm the key
 * belongs to the configured key quorum. Nothing here ever logs or returns private key material.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";

const PREFIXES = /^(wallet-auth:|wallet-api:)/;

function pemToPkcs8B64(pem: string): string {
  return createPrivateKey({ key: pem, format: "pem" }).export({ type: "pkcs8", format: "der" }).toString("base64");
}

/** Bare base64 PKCS#8 for Privy's SDK, or null when the value can't be a private key. */
export function normalizeAuthKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
  v = v.replace(PREFIXES, "");
  try {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) return pemToPkcs8B64(v);
    const compact = v.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
    const text = Buffer.from(compact, "base64").toString("utf8");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return pemToPkcs8B64(text);
    // Already DER PKCS#8: re-export to drop any whitespace while proving it parses.
    return createPrivateKey({ key: Buffer.from(compact, "base64"), format: "der", type: "pkcs8" })
      .export({ type: "pkcs8", format: "der" })
      .toString("base64");
  } catch {
    return null;
  }
}

/** Base64 SPKI DER of the key's public half (what Privy stores on a key quorum), or null. */
export function authPublicKey(raw: string | null | undefined): string | null {
  const k = normalizeAuthKey(raw);
  if (!k) return null;
  try {
    const priv = createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" });
    return createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    return null;
  }
}

/** Compare public keys in any of Privy's spellings (bare base64 SPKI or PEM). */
export function samePublicKey(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => {
    if (!s) return null;
    const t = s.trim();
    try {
      const key = /-----BEGIN PUBLIC KEY-----/.test(t)
        ? createPublicKey({ key: t, format: "pem" })
        : createPublicKey({ key: Buffer.from(t.replace(/\s/g, ""), "base64"), format: "der", type: "spki" });
      return key.export({ type: "spki", format: "der" }).toString("base64");
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return Boolean(x && x === norm(b));
}

/**
 * What kind of value was configured, without revealing any of it (for /api/status when the key can't be read):
 * e.g. a public key pasted where the private key belongs, or a key on the wrong curve.
 */
export type AuthKeyShape = "ok" | "missing" | "public_key" | "not_p256" | "pem_unreadable" | "base64_not_a_key" | "not_base64";
export function authKeyShape(raw: string | null | undefined): AuthKeyShape {
  if (!raw || !raw.trim()) return "missing";
  if (authPublicKey(raw)) {
    const k = createPrivateKey({ key: Buffer.from(normalizeAuthKey(raw)!, "base64"), format: "der", type: "pkcs8" });
    return k.asymmetricKeyDetails?.namedCurve === "prime256v1" ? "ok" : "not_p256";
  }
  let v = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .replace(PREFIXES, "");
  if (/-----BEGIN PUBLIC KEY-----/.test(v)) return "public_key";
  if (/-----BEGIN/.test(v)) return "pem_unreadable";
  v = v.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) return "not_base64";
  try {
    createPublicKey({ key: Buffer.from(v, "base64"), format: "der", type: "spki" });
    return "public_key";
  } catch {
    return "base64_not_a_key";
  }
}
