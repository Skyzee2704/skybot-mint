// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One process-wide undici agent so OpenSea, Privy, and RPC broadcasts reuse TLS sockets.
 * Node's global fetch uses this dispatcher after installKeepAlive().
 */
import { FetchRequest } from "ethers";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

export const KEEP_ALIVE_TIMEOUT_MS = 30_000;
/** Room for a 100-wallet mint wave plus Privy signing and broadcast RPCs on the same agent. */
export const KEEP_ALIVE_CONNECTIONS = 128;

export const keepAliveDispatcher = new Agent({
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  keepAliveMaxTimeout: 60_000,
  connections: KEEP_ALIVE_CONNECTIONS,
  pipelining: 1,
});

let installed = false;
let ethersRouted = false;

/**
 * ethers JsonRpcProvider uses Node's http.request, not global fetch, so the undici agent
 * never sees those reads. Register a getUrl that uses global fetch (and therefore this agent).
 * Privy's SDK calls global fetch directly, so the same dispatcher covers it once installed.
 */
export function routeEthersThroughFetch() {
  if (ethersRouted) return;
  ethersRouted = true;
  FetchRequest.registerGetUrl(async (req: any, signal: any) => {
    const ctrl = new AbortController();
    const onCancel = () => ctrl.abort();
    signal?.addListener?.(onCancel);
    try {
      const res = await fetch(req.url, {
        method: req.method || "GET",
        headers: req.headers,
        body: req.body ? Buffer.from(req.body) : undefined,
        signal: ctrl.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return {
        statusCode: res.status,
        statusMessage: res.statusText,
        headers,
        body: new Uint8Array(await res.arrayBuffer()),
      };
    } finally {
      signal?.removeListener?.(onCancel);
    }
  });
}

export function ethersRoutedThroughFetch(): boolean {
  return ethersRouted;
}

export function installKeepAlive(): Agent {
  if (!installed) {
    setGlobalDispatcher(keepAliveDispatcher);
    installed = true;
  }
  routeEthersThroughFetch();
  return keepAliveDispatcher;
}

export function keepAliveInstalled(): boolean {
  return installed && getGlobalDispatcher() === keepAliveDispatcher;
}

/** Best-effort TLS warmup. Failures are ignored; the hot path still works on a cold socket. */
export async function warmSockets(urls: string[]): Promise<void> {
  installKeepAlive();
  await Promise.all(
    urls.map(async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_500);
      try {
        const rpc = !/opensea\.io|privy\.io/i.test(url);
        await fetch(url, {
          method: rpc ? "POST" : "GET",
          headers: rpc ? { "content-type": "application/json" } : { accept: "application/json" },
          body: rpc ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) : undefined,
          signal: ctrl.signal,
        });
      } catch {
        /* warmup only */
      } finally {
        clearTimeout(t);
      }
    }),
  );
}

export const WARM_HOSTS = ["https://api.opensea.io/api/v2", "https://api.privy.io/"];
