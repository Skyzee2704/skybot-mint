/**
 * Opt-in OpenSea wallet login (official SIWE flow, mirrors @opensea/sdk OpenSeaAuth) used only for
 * GET /api/v2/drops/{slug}/eligibility. Signs an OFF-CHAIN login message (no transaction, no gas);
 * signing in accepts OpenSea's ToS for that wallet. The scoped PAT is revoked right after exchange;
 * the short-lived JWT is held in memory only. Nothing is logged.
 */
import { getAddress, type Wallet } from "ethers";
import { env } from "../../config/env.js";

const API = "https://api.opensea.io";
export const SIWE_STATEMENT = "Click to sign in and accept the Platform Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).";

export function buildSiweMessage(address: string, nonce: string, issuedAt = new Date()): { text: string; fields: Record<string, string> } {
  const a = getAddress(address); const iso = issuedAt.toISOString();
  const text = `opensea.io wants you to sign in with your Ethereum account:\n${a}\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${iso}`;
  return { text, fields: { domain: "opensea.io", address: a, statement: SIWE_STATEMENT, uri: "https://opensea.io", version: "1", chainId: "1", nonce, issuedAt: iso, accountType: "Ethereum" } };
}

export function sessionCookies(h: Headers): string {
  const raw: string[] = (h as any).getSetCookie?.() ?? (h.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  const m = new Map<string, string>();
  for (const c of raw) { const pair = c.split(";")[0]; const i = pair.indexOf("="); if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
  if (!m.has("access_token")) throw new Error("OpenSea SIWE: session cookie missing");
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
}

const jwtCache = new Map<string, { token: string; exp: number }>();

async function ok(r: Response, what: string) { if (!r.ok) throw new Error(`OpenSea ${what} failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 160)}`); }

export async function walletJwt(signer: Wallet, fetchImpl: typeof fetch = fetch): Promise<string> {
  const addr = signer.address.toLowerCase();
  const c = jwtCache.get(addr); if (c && c.exp - Date.now() > 5 * 60_000) return c.token;
  const n = await fetchImpl(`${API}/api/v2/auth/siwe/nonce`, { method: "POST", headers: { accept: "application/json" } }); await ok(n, "nonce");
  const { nonce } = (await n.json()) as any;
  const msg = buildSiweMessage(signer.address, nonce);
  const signature = await signer.signMessage(msg.text); // EIP-191 personal_sign of the login text — not a transaction
  const v = await fetchImpl(`${API}/api/v2/auth/siwe/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg.fields, signature, chainArch: "EVM" }) });
  await ok(v, "SIWE verify");
  const cookie = sessionCookies(v.headers);
  const t = await fetchImpl(`${API}/api/v2/auth/tokens`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ label: `nft-mint-bot-${Date.now()}`, scopes: ["read:eligibility"], expiresInDays: 1 }) });
  await ok(t, "scoped token");
  const pat = (await t.json()) as { id: string; token: string };
  try {
    const x = await fetchImpl(`${API}/api/v2/auth/tokens/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectToken: pat.token, subjectTokenType: "ACCESS_TOKEN" }) });
    await ok(x, "token exchange");
    const ex = (await x.json()) as { accessToken: string; expiresIn?: number };
    jwtCache.set(addr, { token: ex.accessToken, exp: Date.now() + (ex.expiresIn ?? 3600) * 1000 });
    return ex.accessToken;
  } finally {
    // PAT no longer needed; issued JWT stays valid until it expires.
    await fetchImpl(`${API}/api/v2/auth/tokens/${encodeURIComponent(pat.id)}`, { method: "DELETE", headers: { cookie } }).catch(() => {});
  }
}

export interface StageEligibility { stage_uuid: string; is_eligible: boolean; price: string | null; max_total_mintable_by_wallet: string | null }

export async function dropEligibility(signer: Wallet, slug: string, fetchImpl: typeof fetch = fetch): Promise<StageEligibility[]> {
  if (!env.openseaApiKey) throw new Error("OPENSEA_API_KEY not set");
  const jwt = await walletJwt(signer, fetchImpl);
  const r = await fetchImpl(`${API}/api/v2/drops/${encodeURIComponent(slug)}/eligibility`, { headers: { "x-api-key": env.openseaApiKey, authorization: `Bearer ${jwt}`, accept: "application/json" } });
  await ok(r, "eligibility");
  return ((await r.json()) as any).stages ?? [];
}
