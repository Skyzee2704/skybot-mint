import { env } from "../../config/env.js";
import type { ChainConfig } from "../../config/chains.js";

/** Etherscan API v2 (multichain): one key, `chainid` param selects the chain. */
const BASE = "https://api.etherscan.io/v2/api";

export interface VerifiedSource { abi: any[] | null; contractName?: string; isProxy: boolean; implementation?: string; error?: string }

export async function fetchVerifiedAbi(chainId: number, address: string, apiKey = env.etherscanApiKey, fetchImpl: typeof fetch = fetch): Promise<VerifiedSource> {
  if (!apiKey) return { abi: null, isProxy: false, error: "ETHERSCAN_API_KEY not set" };
  const q = async (addr: string) => {
    const url = `${BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${addr}&apikey=${apiKey}`;
    for (let i = 0; i < 3; i++) {
      const res = await fetchImpl(url);
      const j: any = await res.json().catch(() => null);
      if (j?.status === "1" && Array.isArray(j.result)) return j.result[0];
      const msg = String(j?.result ?? j?.message ?? res.status);
      if (/rate limit|max calls/i.test(msg) && i < 2) { await new Promise((r) => setTimeout(r, 600 * (i + 1))); continue; }
      throw new Error(`Etherscan: ${msg.slice(0, 200)}`);
    }
  };
  try {
    const r = await q(address);
    const parseAbi = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    let abi = r?.ABI && !/not verified/i.test(r.ABI) ? parseAbi(r.ABI) : null;
    const isProxy = r?.Proxy === "1" && /^0x[0-9a-fA-F]{40}$/.test(r?.Implementation ?? "");
    let contractName = r?.ContractName;
    if (isProxy) {
      const impl = await q(r.Implementation);
      const implAbi = impl?.ABI ? parseAbi(impl.ABI) : null;
      if (implAbi) { abi = [...implAbi, ...(abi ?? [])]; contractName = impl.ContractName || contractName; }
    }
    return { abi, contractName, isProxy, implementation: isProxy ? r.Implementation : undefined, error: abi ? undefined : "Contract source not verified" };
  } catch (e: any) {
    return { abi: null, isProxy: false, error: e.message };
  }
}

/** Sourcify v2 (keyless) fallback for verified ABIs. */
export async function fetchSourcifyAbi(chainId: number, address: string, fetchImpl: typeof fetch = fetch): Promise<any[] | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetchImpl(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j: any = await res.json();
    return Array.isArray(j?.abi) ? j.abi : null;
  } catch { return null; }
}

/** Blockscout (Etherscan-compatible API, usually keyless). */
export async function fetchBlockscoutAbi(apiBase: string, address: string, fetchImpl: typeof fetch = fetch): Promise<any[] | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetchImpl(`${apiBase}?module=contract&action=getabi&address=${address}`, { signal: ctrl.signal });
    clearTimeout(t);
    const j: any = await res.json().catch(() => null); // Cloudflare challenge pages are HTML -> null
    if (j?.status === "1" && typeof j.result === "string") { const abi = JSON.parse(j.result); return Array.isArray(abi) ? abi : null; }
    return null;
  } catch { return null; }
}

export type AbiSource = "etherscan" | "blockscout" | "sourcify" | "none";
/** Order: Etherscan v2 (if chain supported + key) -> Blockscout -> Sourcify. Proxy implementations are merged in. */
export async function resolveAbi(chain: ChainConfig, address: string, implementation?: string): Promise<{ abi: any[] | null; source: AbiSource; note?: string; contractName?: string }> {
  const notes: string[] = [];
  if (chain.etherscanV2) {
    const es = await fetchVerifiedAbi(chain.chainId, address);
    if (es.abi) return { abi: es.abi, source: "etherscan", contractName: es.contractName };
    if (es.error) notes.push(`etherscan: ${es.error}`);
  } else notes.push("etherscan v2 not configured for this chain");
  const addrs = [address, ...(implementation ? [implementation] : [])];
  if (chain.blockscoutApi) {
    const merged: any[] = [];
    for (const a of addrs) { const abi = await fetchBlockscoutAbi(chain.blockscoutApi, a); if (abi) merged.push(...abi); }
    if (merged.length) return { abi: merged, source: "blockscout", note: notes.join("; ") };
    notes.push("blockscout: no verified ABI");
  }
  const merged: any[] = [];
  for (const a of addrs) { const abi = await fetchSourcifyAbi(chain.chainId, a); if (abi) merged.push(...abi); }
  if (merged.length) return { abi: merged, source: "sourcify", note: notes.join("; ") };
  notes.push("sourcify: not verified");
  return { abi: null, source: "none", note: notes.join("; ") };
}
