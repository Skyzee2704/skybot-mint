// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every SkyBOT chain must be in PrivyProvider `supportedChains`. Privy's default list (react-auth 3.50 /
 * js-sdk-core 0.79) has 32 chains but NOT Ink (57073), Robinhood (4663) or Arc (5042). For a chain outside the list,
 * Privy's signTransaction throws inside an async Promise executor, so the promise never settles and the UI hangs on
 * "Signing". Chains in Privy's defaults keep Privy's entry (with its RPC); the others use our public RPCs (never keyed
 * URLs, this runs in the browser).
 */
import { SUPPORTED_CHAINS } from "@privy-io/react-auth";
import { defineChain, type Chain } from "viem";
import { CHAINS } from "@nft-mint-bot/server/chains";

export const PRIVY_CHAINS: Chain[] = CHAINS.map((c) => {
  const builtIn = (SUPPORTED_CHAINS as readonly Chain[]).find((x) => x.id === c.chainId);
  if (builtIn) return builtIn;
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: c.publicRpcs } },
    blockExplorers: { default: { name: `${c.name} Explorer`, url: c.explorer } },
  });
});
export const PRIVY_CHAIN_IDS = new Set(PRIVY_CHAINS.map((c) => c.id));
export const DEFAULT_PRIVY_CHAIN = PRIVY_CHAINS.find((c) => c.id === 8453) ?? PRIVY_CHAINS[0];
