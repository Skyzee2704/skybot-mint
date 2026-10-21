// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Opt-in OpenSea wallet login (official SIWE flow, mirrors @opensea/sdk OpenSeaAuth) used only for
 * GET /api/v2/drops/{slug}/eligibility. Signs an OFF-CHAIN login message (no transaction, no gas);
 * signing in accepts OpenSea's ToS for that wallet. The scoped PAT is revoked right after exchange;
 * the short-lived JWT is held in memory only. Nothing is logged.
 */
import { getAddress, type Wallet } from "ethers";
import { env } from "../../config/env.js";
import { OPENSEA_SIWE_STATEMENT } from "./siweGuard.js";

const API = "https://api.opensea.io";
export const SIWE_STATEMENT = OPENSEA_SIWE_STATEMENT;

export function buildSiweMessage(address: string, nonce: string, issuedAt = new Date()): { text: string; fields: Record<string, string> } {
  const a = getAddress(address);
  const iso = issuedAt.toISOString();
  const text = `opensea.io wants you to sign in with your Ethereum account:\n${a}\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${iso}`;
  return {
    text,
    fields: {
      domain: "opensea.io",
      address: a,
      statement: SIWE_STATEMENT,
      uri: "https://opensea.io",
      version: "1",
      chainId: "1",
      nonce,
      issuedAt: iso,
      accountType: "Ethereum",
    },
  };
}

export function sessionCookies(h: Headers): string {
  const raw: string[] = (h as any).getSetCookie?.() ?? (h.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  const m = new Map<string, string>();
  for (const c of raw) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  if (!m.has("access_token")) throw new Error("OpenSea SIWE: session cookie missing");
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
}

const jwtCache = new Map<string, { token: string; exp: number }>();

async function ok(r: Response, what: string) {
  if (!r.ok) throw new Error(`OpenSea ${what} failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 160)}`);
}

/** A still-valid cached wallet JWT (in-memory, per server instance). */
export function cachedJwt(address: string): string | null {
  const c = jwtCache.get(address.toLowerCase());
  return c && c.exp - Date.now() > 5 * 60_000 ? c.token : null;
}

/** Step 1: single-use nonce + the exact login text the wallet must sign (personal_sign). */
export async function prepareSiwe(address: string, fetchImpl: typeof fetch = fetch) {
  const n = await fetchImpl(`${API}/api/v2/auth/siwe/nonce`, { method: "POST", headers: { accept: "application/json" } });
  await ok(n, "nonce");
  const { nonce } = (await n.json()) as any;
  if (typeof nonce !== "string" || !nonce) throw new Error("OpenSea nonce missing");
  return buildSiweMessage(address, nonce);
}

/** Only accept the exact OpenSea login layout (prevents using this endpoint as a generic signing oracle). */
export function validateSiweFields(fields: Record<string, string>, expectedAddress: string, nowMs = Date.now()) {
  const issued = Date.parse(fields.issuedAt ?? "");
  const okShape =
    fields.domain === "opensea.io" &&
    fields.uri === "https://opensea.io" &&
    fields.statement === SIWE_STATEMENT &&
    fields.version === "1" &&
    fields.chainId === "1" &&
    fields.accountType === "Ethereum" &&
    typeof fields.nonce === "string" &&
    /^[A-Za-z0-9-]{8,128}$/.test(fields.nonce) &&
    Number.isFinite(issued) &&
    Math.abs(nowMs - issued) < 10 * 60_000;
  if (!okShape) throw new Error("Invalid OpenSea sign-in message");
  if (getAddress(fields.address) !== getAddress(expectedAddress)) throw new Error("Sign-in message is for a different wallet");
}

/** Steps 2-4: verify the signed login with OpenSea → scoped PAT (read:eligibility) → wallet JWT. PAT revoked after. */
export async function jwtFromSignature(
  fields: Record<string, string>,
  signature: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const addr = fields.address.toLowerCase();
  const cached = cachedJwt(addr);
  if (cached) return cached;
  const v = await fetchImpl(`${API}/api/v2/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: fields, signature, chainArch: "EVM" }),
  });
  await ok(v, "SIWE verify");
  const cookie = sessionCookies(v.headers);
  const t = await fetchImpl(`${API}/api/v2/auth/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ label: `skybot-${Date.now()}`, scopes: ["read:eligibility"], expiresInDays: 1 }),
  });
  await ok(t, "scoped token");
  const pat = (await t.json()) as { id: string; token: string };
  try {
    const x = await fetchImpl(`${API}/api/v2/auth/tokens/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectToken: pat.token, subjectTokenType: "ACCESS_TOKEN" }),
    });
    await ok(x, "token exchange");
    const ex = (await x.json()) as { accessToken: string; expiresIn?: number };
    jwtCache.set(addr, { token: ex.accessToken, exp: Date.now() + (ex.expiresIn ?? 3600) * 1000 });
    return ex.accessToken;
  } finally {
    // PAT no longer needed; issued JWT stays valid until it expires.
    await fetchImpl(`${API}/api/v2/auth/tokens/${encodeURIComponent(pat.id)}`, { method: "DELETE", headers: { cookie } }).catch(() => {});
  }
}

/** Server-held key path (tests / scripts). Product wallets sign in the browser via Privy instead. */
export async function walletJwt(signer: Wallet, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = cachedJwt(signer.address);
  if (cached) return cached;
  const msg = await prepareSiwe(signer.address, fetchImpl);
  const signature = await signer.signMessage(msg.text); // EIP-191 personal_sign of the login text — not a transaction
  return jwtFromSignature(msg.fields, signature, fetchImpl);
}

export interface StageEligibility {
  stage_uuid: string;
  is_eligible: boolean;
  price: string | null;
  max_total_mintable_by_wallet: string | null;
}

export async function dropEligibility(signer: Wallet, slug: string, fetchImpl: typeof fetch = fetch): Promise<StageEligibility[]> {
  return eligibilityWithJwt(await walletJwt(signer, fetchImpl), slug, fetchImpl);
}

/** GET /api/v2/drops/{slug}/eligibility — per-stage verdict incl. upcoming stages. No balance needed. */
export async function eligibilityWithJwt(jwt: string, slug: string, fetchImpl: typeof fetch = fetch): Promise<StageEligibility[]> {
  if (!env.openseaApiKey) throw new Error("OPENSEA_API_KEY not set");
  const r = await fetchImpl(`${API}/api/v2/drops/${encodeURIComponent(slug)}/eligibility`, {
    headers: { "x-api-key": env.openseaApiKey, authorization: `Bearer ${jwt}`, accept: "application/json" },
  });
  await ok(r, "eligibility");
  return ((await r.json()) as any).stages ?? [];
}
