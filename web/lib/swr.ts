"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tiny stale-while-revalidate store (no dependency). Per SkyBOT user, persisted to localStorage (public data only:
 * balances and NFT lists, never keys or tokens), cleared on sign-out.
 *  - render instantly from the last value, revalidate in the background, update in place;
 *  - one in-flight request per key (dedupe), plus a short "fresh" window so mounts/prefetch don't refetch;
 *  - revalidates when the tab becomes visible again if the value is older than `staleMs`.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readChainPref, writeChainPref } from "./chainPref";

const PREFIX = "skybot:swr:v1";
const MAX_PERSIST_CHARS = 2_000_000;

export type Snap<T> = { data: T | undefined; at: number; error: string | null; validating: boolean };
type Entry = { snap: Snap<any>; inflight: Promise<any> | null; listeners: Set<() => void> };

let scope: string | null = null;
const store = new Map<string, Entry>();
const EMPTY: Snap<any> = { data: undefined, at: 0, error: null, validating: false };

const storageKey = (key: string) => `${PREFIX}:${scope}:${key}`;

/** Switch the cache to this user (drops in-memory values of any other user). */
export function setCacheScope(userId: string | null) {
  if (userId === scope) return;
  scope = userId;
  for (const [key, e] of store) {
    e.snap = hydrate(key);
    e.inflight = null;
    e.listeners.forEach((l) => l());
  }
  try {
    if (userId) window.localStorage.setItem(`${PREFIX}:last`, userId);
  } catch {
    /* */
  }
}

/** Before /api/me resolves, use the last signed-in user's slot so the first paint is instant. */
function ensureScope() {
  if (scope || typeof window === "undefined") return;
  try {
    scope = window.localStorage.getItem(`${PREFIX}:last`);
  } catch {
    /* */
  }
}

function hydrate(key: string): Snap<any> {
  if (!scope || typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as { data: unknown; at: number };
    return { data: v.data, at: v.at, error: null, validating: false };
  } catch {
    return EMPTY;
  }
}

function entry(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    ensureScope();
    e = { snap: hydrate(key), inflight: null, listeners: new Set() };
    store.set(key, e);
  }
  return e;
}

function set(key: string, patch: Partial<Snap<any>>) {
  const e = entry(key);
  e.snap = { ...e.snap, ...patch };
  e.listeners.forEach((l) => l());
}

function persist(key: string, data: unknown, at: number) {
  if (!scope) return;
  try {
    const s = JSON.stringify({ data, at });
    if (s.length <= MAX_PERSIST_CHARS) window.localStorage.setItem(storageKey(key), s);
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    /* quota / disabled storage: memory only */
  }
}

export function peek<T>(key: string): Snap<T> {
  return entry(key).snap;
}

/** Write a value (e.g. a response that already carries the new data). */
export function mutate<T>(key: string, data: T | ((d: T | undefined) => T), at = Date.now()) {
  const e = entry(key);
  const next = typeof data === "function" ? (data as (d: T | undefined) => T)(e.snap.data) : data;
  set(key, { data: next, at, error: null });
  persist(key, next, at);
}

/**
 * Fetch (deduped). Skips the network when the value is younger than `freshMs` unless `force`.
 * `asOf` lets the response say how old the data really is (e.g. a server cache time).
 */
export async function revalidate<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { force?: boolean; freshMs?: number; asOf?: (d: T) => number | null } = {},
): Promise<T | undefined> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  if (!opts.force && e.snap.data !== undefined && Date.now() - e.snap.at < (opts.freshMs ?? 5_000)) return e.snap.data;
  const owner = scope;
  set(key, { validating: true });
  const p = fetcher()
    .then((d) => {
      if (owner !== scope) return d; // signed out / switched user meanwhile
      const at = opts.asOf?.(d) ?? Date.now();
      set(key, { data: d, at, error: null, validating: false });
      persist(key, d, at);
      return d;
    })
    .catch((err: any) => {
      if (owner === scope) set(key, { error: String(err?.message ?? err), validating: false });
      return undefined;
    })
    .finally(() => {
      e.inflight = null;
    });
  e.inflight = p;
  return p;
}

/** Remove every persisted value (sign-out). */
export function clearSwrCache() {
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith(PREFIX)) window.localStorage.removeItem(k);
  } catch {
    /* */
  }
  scope = null;
  for (const e of store.values()) {
    e.snap = EMPTY;
    e.inflight = null;
    e.listeners.forEach((l) => l());
  }
}

/** React binding. `key = null` disables. */
export function useSWR<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: { freshMs?: number; staleMs?: number; asOf?: (d: T) => number | null } = {},
) {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const e = entry(key);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    [key],
  );
  const snap = useSyncExternalStore(
    subscribe,
    () => (key ? entry(key).snap : EMPTY) as Snap<T>,
    () => EMPTY as Snap<T>,
  );
  const { freshMs, staleMs = 15_000, asOf } = opts;
  const run = useCallback(
    (force = false) => (key ? revalidate<T>(key, fetcher, { force, freshMs, asOf }) : Promise.resolve(undefined)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, freshMs],
  );
  useEffect(() => {
    void run();
    if (!key) return;
    const onVis = () => {
      if (document.visibilityState === "visible" && Date.now() - entry(key).snap.at > staleMs) void run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [run, key, staleMs]);
  return {
    data: snap.data,
    at: snap.at,
    error: snap.error,
    validating: snap.validating,
    /** Nothing to show yet (first visit). */
    loading: snap.data === undefined && !snap.error,
    revalidate: run,
    mutate: (d: T | ((x: T | undefined) => T)) => key && mutate(key, d),
  };
}

/** "just now", "12s ago", "3m ago", "2h ago". */
export function ago(at: number, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/* ---------- shared keys / fetchers ---------- */
type Api = <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
/** Wallets balance chain (shared localStorage preference; see lib/chainPref.ts). */
export const preferredBalanceChain = () => readChainPref("balances", "base");
export const setPreferredBalanceChain = (c: string) => writeChainPref("balances", c);
export const balancesKey = (chain: string) => `balances:${chain}`;
export const balancesFetcher =
  (api: Api, chain: string, fresh = false) =>
  () =>
    api<{ chain: string; asOf?: string; balances: { walletId: string; balance: string | null }[] }>("/api/wallets/balances", {
      body: fresh ? { chain, fresh: true } : { chain },
    });
export const balancesAsOf = (d: { asOf?: string }) => (d?.asOf ? Date.parse(d.asOf) : null);
export const NFTS_KEY = "nfts";
export const nftsFetcher = (api: Api) => () => api<any>("/api/nfts");

/** Warm the Wallets and NFTs menus once after sign-in (deduped with the pages' own requests). */
export function prefetchMenus(api: Api) {
  const chain = preferredBalanceChain();
  void revalidate(balancesKey(chain), balancesFetcher(api, chain), { freshMs: 15_000, asOf: balancesAsOf });
  void revalidate(NFTS_KEY, nftsFetcher(api), { freshMs: 15_000 });
}
