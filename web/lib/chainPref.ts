"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Last chosen network per picker, remembered on this device (localStorage; public preference only).
 * Same mechanism the Wallets balance selector has always used ("skybot:pref:balanceChain").
 */
import { useCallback, useState } from "react";

export const CHAIN_PREF_KEYS = {
  balances: "skybot:pref:balanceChain",
  fund: "skybot:pref:fundChain",
  withdraw: "skybot:pref:withdrawChain",
  nftsFilter: "skybot:pref:nftsChain",
} as const;
export type ChainPrefScope = keyof typeof CHAIN_PREF_KEYS;

const VALID = /^[a-z0-9-]{0,32}$/;

export function readChainPref(scope: ChainPrefScope, fallback: string): string {
  try {
    const v = window.localStorage.getItem(CHAIN_PREF_KEYS[scope]);
    return v !== null && VALID.test(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeChainPref(scope: ChainPrefScope, chain: string) {
  try {
    if (VALID.test(chain)) window.localStorage.setItem(CHAIN_PREF_KEYS[scope], chain);
  } catch {
    /* storage disabled */
  }
}

/** `useState` for a chain picker that survives page refresh. `fallback` may be "" (e.g. "All chains"). */
export function usePersistedChain(scope: ChainPrefScope, fallback = "base"): [string, (c: string) => void] {
  const [chain, setState] = useState(() => (typeof window === "undefined" ? fallback : readChainPref(scope, fallback)));
  const setChain = useCallback(
    (c: string) => {
      writeChainPref(scope, c);
      setState(c);
    },
    [scope],
  );
  return [chain, setChain];
}
