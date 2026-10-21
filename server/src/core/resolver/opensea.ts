import { env } from "../../config/env.js";

/**
 * Client for OpenSea's OFFICIAL REST API (api.opensea.io/api/v2) only.
 * The internal gql.opensea.io API is intentionally not used.
 * Every method degrades gracefully when OPENSEA_API_KEY is missing.
 */
const BASE = "https://api.opensea.io";

export class OpenSeaUnavailable extends Error { constructor(m: string) { super(m); this.name = "OpenSeaUnavailable"; } }
export class OpenSeaHttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "OpenSeaHttpError"; }
}

export interface OsStage {
  uuid?: string; stage_type?: string; label?: string; price?: string; price_currency_address?: string;
  start_time?: string; end_time?: string; max_per_wallet?: string;
}
export interface OsDrop {
  collection_slug: string; collection_name?: string; chain: string; contract_address: string; drop_type: string;
  is_minting: boolean; opensea_url?: string; image_url?: string; active_stage?: OsStage | null; next_stage?: OsStage | null;
  stages?: OsStage[]; total_supply?: string; max_supply?: string;
}
export interface OsCollection { collection: string; name?: string; contracts?: { address: string; chain: string }[]; image_url?: string; opensea_url?: string }
export interface OsMintTx { to: string; data: string; value: string; chain: string }

type FetchFn = typeof fetch;

export class OpenSeaClient {
  constructor(private apiKey: string | undefined = env.openseaApiKey, private fetchImpl: FetchFn = fetch) {}
  get available() { return Boolean(this.apiKey); }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, allowNoKey = false): Promise<T> {
    if (!this.apiKey && !allowNoKey) throw new OpenSeaUnavailable("OPENSEA_API_KEY not set — OpenSea features disabled");
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "nft-mint-bot/0.1" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (body) headers["content-type"] = "application/json";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await this.fetchImpl(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
        const text = await res.text();
        let json: any = undefined; try { json = text ? JSON.parse(text) : undefined; } catch { /* non-json */ }
        if (res.ok) return json as T;
        const msg = (json?.errors?.join?.("; ") ?? json?.detail ?? json?.message ?? text ?? "").toString().slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          const ra = Number(res.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 5) * 1000 : 500 * 2 ** attempt));
          lastErr = new OpenSeaHttpError(res.status, msg); continue;
        }
        throw new OpenSeaHttpError(res.status, msg || `HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof OpenSeaHttpError) throw e;
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } finally { clearTimeout(t); }
    }
    throw lastErr;
  }

  /** Collection lookup. Works without key sometimes; we try unauthenticated as a fallback. */
  getCollection(slug: string) { return this.req<OsCollection>("GET", `/api/v2/collections/${encodeURIComponent(slug)}`, undefined, true); }
  getDrop(slug: string) { return this.req<OsDrop>("GET", `/api/v2/drops/${encodeURIComponent(slug)}`); }
  /** Contract -> collection (official endpoint: /api/v2/chain/{chain}/contract/{address}). */
  getContract(chain: string, address: string) { return this.req<{ collection?: string; name?: string }>("GET", `/api/v2/chain/${chain}/contract/${address}`); }
  /**
   * Build a ready-to-sign mint tx (official). 200 = eligible now; 409 = stage not active;
   * 422 = not eligible (allowlist / limit / funds) with a reason message. Read-only: nothing is minted.
   */
  buildMint(slug: string, minter: string, quantity: number) {
    return this.req<OsMintTx>("POST", `/api/v2/drops/${encodeURIComponent(slug)}/mint`, { minter, quantity });
  }
}

export const opensea = () => new OpenSeaClient();
