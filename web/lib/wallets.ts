"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";

export type WalletItem = {
  id: string;
  label: string;
  address: string;
  source: string;
  isMain: boolean;
  privyWalletId: string | null;
  createdAt?: string;
  removedAt?: string | null;
};
export type WalletData = {
  wallets: WalletItem[];
  /** Wallets hidden from SkyBOT (still in Privy custody). */
  removedWallets?: WalletItem[];
};

/** Same order as the server: Main first, then oldest added / imported first, then id (stable). */
export function sortWallets<T extends { isMain: boolean; createdAt?: string; id: string }>(ws: readonly T[]): T[] {
  return [...ws].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    const x = a.createdAt ?? "";
    const y = b.createdAt ?? "";
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
const ordered = (d: WalletData): WalletData => ({ ...d, wallets: sortWallets(d.wallets ?? []) });

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
    if (c) setData(ordered(c));
  }, [userId]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = ordered(await api<WalletData>("/api/wallets"));
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

  /** Optimistic local update (also written to the cache so a reload never flashes stale rows). */
  const mutate = useCallback((fn: (d: WalletData) => WalletData) => {
    setData((d) => {
      const next = ordered(fn(d ?? { wallets: [], removedWallets: [] }));
      writeCache(next);
      return next;
    });
  }, []);

  /** Make one wallet Main locally right away (it moves to the top); the caller then reloads from the server. */
  const setMainLocal = useCallback(
    (id: string) => mutate((d) => ({ ...d, wallets: d.wallets.map((w) => ({ ...w, isMain: w.id === id })) })),
    [mutate],
  );

  return {
    data,
    wallets: data?.wallets ?? [],
    removedWallets: data?.removedWallets ?? [],
    loading: !data && refreshing,
    refreshing,
    err,
    reload,
    mutate,
    setMainLocal,
  };
}
