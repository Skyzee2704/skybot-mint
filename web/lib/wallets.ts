"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";

export type WalletItem = {
  id: string;
  label: string;
  address: string;
  group: string | null;
  source: string;
  isMain: boolean;
  privyWalletId: string | null;
};
export type WalletData = { wallets: WalletItem[]; groups: { name: string; count: number }[] };

const PREFIX = "skybot:wallets:v1";
let KEY = PREFIX;

/** Last known wallet list (addresses + labels only — public data, never keys). */
function readCache(): WalletData | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    return raw ? (JSON.parse(raw) as WalletData) : null;
  } catch {
    return null;
  }
}
function writeCache(d: WalletData) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage full / disabled */
  }
}
export function clearWalletCache() {
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith(PREFIX)) window.localStorage.removeItem(k);
  } catch {
    /* */
  }
}

/**
 * Stale-while-revalidate wallet list: renders the cached list instantly, refreshes from the server in the
 * background. `loading` is true only when there is nothing to show yet.
 */
export function useWalletList(
  api: <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>,
  userId: string | null = null,
) {
  const [data, setData] = useState<WalletData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  // Cache is per SkyBOT user; before /api/me resolves we use the last signed-in user's slot.
  if (typeof window !== "undefined") {
    if (userId) {
      KEY = `${PREFIX}:${userId}`;
      try {
        window.localStorage.setItem(`${PREFIX}:last`, userId);
      } catch {
        /* */
      }
    } else {
      try {
        const last = window.localStorage.getItem(`${PREFIX}:last`);
        KEY = last ? `${PREFIX}:${last}` : PREFIX;
      } catch {
        /* */
      }
    }
  }

  useEffect(() => {
    const c = readCache();
    if (c) setData(c);
  }, [userId]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<WalletData>("/api/wallets");
      setData(d);
      writeCache(d);
      setErr(null);
      return d;
    } catch (e: any) {
      setErr(e.message);
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, wallets: data?.wallets ?? [], groups: data?.groups ?? [], loading: !data && refreshing, refreshing, err, reload };
}
