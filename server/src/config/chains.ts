// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Chain registry. Adding a chain = adding one entry here.
 *
 * RPC priority (per chain):
 *   1. RPC_URLS_<KEY> / RPC_URL_<KEY> / RPC_<KEY>  (private RPCs, e.g. Alchemy; highest priority)
 *   3. built-in public RPC defaults below (used automatically, rotated on errors)
 *
 * `sendOnly` endpoints (e.g. Base sequencer) are used only for broadcasting.
 */
export interface ChainConfig {
  key: string; // our id, also used in env var names (upper-cased): RPC_<KEY>, RPC_URL_<KEY>, RPC_URLS_<KEY>
  chainId: number;
  name: string;
  nativeSymbol: string;
  explorer: string; // base URL, no trailing slash
  openseaChain: string; // OpenSea chain slug used in URLs/API
  publicRpcs: string[]; // reputable keyless fallbacks
  sendOnlyRpcs?: string[];
  /** ABI sources: Etherscan v2 multichain (if supported for this chain id) and/or a Blockscout instance. */
  etherscanV2?: boolean;
  blockscoutApi?: string; // Etherscan-compatible ".../api"
  /** SeaDrop V1 (0x00005EA0…24bf5) verified deployed via eth_getCode on 2026-10-21. */
  seadrop: boolean;
  /**
   * Rollup stack, for fee math: "op" = OP Stack (extra L1 data fee from GasPriceOracle 0x…420…0F, verified on-chain
   * 2026-10-21 for Base/Unichain/Ink); "arbitrum" = Nitro/Orbit (L1 cost is folded into gas units by eth_estimateGas).
   */
  stack?: "op" | "arbitrum";
  /** Optional per-chain safety overrides (native units). */
  safety?: { maxPricePerNft?: string; maxDailySpend?: string };
}

export const CHAINS: ChainConfig[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    openseaChain: "ethereum",
    publicRpcs: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://1rpc.io/eth",
      "https://cloudflare-eth.com",
      "https://eth.merkle.io",
    ],
    etherscanV2: true,
    blockscoutApi: "https://eth.blockscout.com/api",
    seadrop: true,
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    openseaChain: "base",
    publicRpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
    sendOnlyRpcs: ["https://mainnet-sequencer.base.org"],
    etherscanV2: true,
    blockscoutApi: "https://base.blockscout.com/api",
    seadrop: true,
    stack: "op",
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon",
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    openseaChain: "polygon",
    publicRpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://1rpc.io/matic"],
    etherscanV2: true,
    blockscoutApi: "https://polygon.blockscout.com/api",
    seadrop: true,
    safety: { maxPricePerNft: "200", maxDailySpend: "1000" }, // POL-denominated defaults
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
    openseaChain: "arbitrum",
    publicRpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    etherscanV2: true,
    blockscoutApi: "https://arbitrum.blockscout.com/api",
    seadrop: true,
    stack: "arbitrum",
  },
  {
    key: "bnb",
    chainId: 56,
    name: "BNB Smart Chain",
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    openseaChain: "bsc",
    publicRpcs: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"],
    etherscanV2: true,
    seadrop: true,
    safety: { maxPricePerNft: "0.1", maxDailySpend: "0.5" },
  },
  {
    key: "unichain",
    chainId: 130,
    name: "Unichain",
    nativeSymbol: "ETH",
    explorer: "https://uniscan.xyz",
    openseaChain: "unichain",
    publicRpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com", "https://unichain.drpc.org"],
    etherscanV2: true,
    blockscoutApi: "https://unichain.blockscout.com/api",
    seadrop: true,
    stack: "op",
  },
  {
    key: "ink",
    chainId: 57073,
    name: "Ink",
    nativeSymbol: "ETH",
    explorer: "https://explorer.inkonchain.com",
    openseaChain: "ink",
    publicRpcs: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com", "https://ink.drpc.org"],
    blockscoutApi: "https://explorer.inkonchain.com/api",
    seadrop: true, // not in Etherscan v2 chainlist (verified 2026-10)
    stack: "op",
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
    openseaChain: "robinhood",
    publicRpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    sendOnlyRpcs: ["https://sequencer.mainnet.chain.robinhood.com"],
    etherscanV2: true,
    blockscoutApi: "https://robinhoodchain.blockscout.com/api",
    seadrop: true,
    stack: "arbitrum",
  },
  {
    key: "arc",
    chainId: 5042,
    name: "Arc",
    nativeSymbol: "USDC",
    explorer: "https://explorer.arc.io",
    openseaChain: "arc",
    publicRpcs: ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"],
    etherscanV2: true,
    blockscoutApi: "https://explorer.arc.io/api",
    seadrop: true,
    safety: { maxPricePerNft: "100", maxDailySpend: "500" }, // USDC-denominated defaults (native gas token is USDC)
  },
  // Add a chain: copy an entry, set chainId/explorer/publicRpcs, then set RPC_<KEY> in env.
];

const ALIASES: Record<string, string> = {
  eth: "ethereum",
  mainnet: "ethereum",
  matic: "polygon",
  bsc: "bnb",
  binance: "bnb",
  arb: "arbitrum",
  arbitrum_one: "arbitrum",
};

export function getChain(keyOrId: string | number | bigint | undefined | null): ChainConfig | undefined {
  if (keyOrId === undefined || keyOrId === null) return undefined;
  if (typeof keyOrId === "string" && !/^\d+$/.test(keyOrId)) {
    const k = keyOrId.trim().toLowerCase();
    const key = ALIASES[k] ?? k;
    return CHAINS.find((c) => c.key === key || c.openseaChain === key);
  }
  const id = Number(keyOrId);
  return CHAINS.find((c) => c.chainId === id);
}

export function requireChain(keyOrId: string | number | bigint): ChainConfig {
  const c = getChain(keyOrId);
  if (!c) throw new Error(`Unsupported chain "${keyOrId}". Supported: ${CHAINS.map((x) => x.key).join(", ")}`);
  return c;
}

function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

export interface ResolvedRpcs {
  read: string[]; // ordered: private first, then public
  send: string[]; // read endpoints + send-only endpoints (deduped)
  hasPrivate: boolean;
}

export function rpcsForChain(chain: ChainConfig, env: NodeJS.ProcessEnv = process.env): ResolvedRpcs {
  const K = chain.key.toUpperCase();
  const priv = [...splitList(env[`RPC_URLS_${K}`]), ...splitList(env[`RPC_URL_${K}`]), ...splitList(env[`RPC_${K}`])];
  const usePublic = env[`DISABLE_PUBLIC_RPCS_${K}`] !== "true";
  const read = dedupe([...priv, ...(usePublic || priv.length === 0 ? chain.publicRpcs : [])]);
  const send = dedupe([...read, ...(chain.sendOnlyRpcs ?? [])]);
  return { read, send, hasPrivate: priv.length > 0 };
}

function dedupe(a: string[]): string[] {
  return [...new Set(a.map((u) => u.replace(/\/+$/, "")))];
}

export function explorerTx(chain: ChainConfig, hash: string) {
  return `${chain.explorer}/tx/${hash}`;
}
export function explorerAddress(chain: ChainConfig, addr: string) {
  return `${chain.explorer}/address/${addr}`;
}
