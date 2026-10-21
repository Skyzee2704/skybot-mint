"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getIdentityToken, usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import { localTimeZone } from "@/lib/time";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTelegram } from "@/lib/telegram";
import { clearWalletCache } from "@/lib/wallets";

/** How long the Mini App waits for Privy's seamless Telegram login before using the verified-initData fallback. */
const SEAMLESS_WAIT_MS = 2500;

type ShellState = {
  /** Signed in via the SkyBOT Telegram session fallback (no Privy session in this browser). */
  tgOnly: boolean;
  /** Open Privy's Telegram login so Privy-only features (wallet import, generation) work. */
  connectPrivy: () => void;
  /** SkyBOT user id once /api/me resolved (scopes client caches). */
  userId: string | null;
};
const ShellCtx = createContext<ShellState>({ tgOnly: false, connectPrivy: () => {}, userId: null });
export const useShell = () => useContext(ShellCtx);

/** Identity token (if enabled in the Privy dashboard) lets the server match linked Telegram/email without an API call. */
async function idTokenOrNull() {
  try {
    return await getIdentityToken();
  } catch {
    return null;
  }
}

/** Silently remember the browser timezone so Telegram messages use it too. Never blocks or surfaces errors. */
function saveTimeZone(saved: string | null | undefined, auth: { token?: string | null; idToken?: string | null }) {
  try {
    const tz = localTimeZone();
    if (!tz || tz === saved) return;
    void api("/api/me/timezone", { method: "PUT", body: { timeZone: tz }, ...auth }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { isMiniApp, initData, webApp } = useTelegram();
  const [me, setMe] = useState<any>(null);
  const [tgOnly, setTgOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const path = usePathname();
  const router = useRouter();
  const { addSigners } = useSigners();
  const { wallets: privyWallets } = useWallets();
  // Sign-in-only signer (Privy policy allows personal_sign of OpenSea's login text only) added silently to each
  // embedded wallet, so the Telegram /check can verify upcoming OpenSea stages. Never blocks or shows errors.
  useEffect(() => {
    const sg = me?.siweSigner;
    if (!authenticated || !sg?.signerId || !sg?.policyId) return;
    // Every Privy embedded EVM wallet of this user: linked accounts (generated, imported, server-created) + connected.
    const addrs = new Set<string>();
    for (const a of (user?.linkedAccounts ?? []) as any[]) {
      if (a?.type === "wallet" && a?.walletClientType === "privy" && (a?.chainType ?? "ethereum") === "ethereum" && a?.address) {
        addrs.add(String(a.address));
      }
    }
    for (const w of privyWallets ?? []) if (w.walletClientType === "privy") addrs.add(w.address);
    let cancelled = false;
    (async () => {
      // Sequential: each call reads then rewrites the wallet's signer list, so parallel calls could race.
      for (const address of addrs) {
        if (cancelled) return;
        const k = `skybot:siwe-signer:${sg.signerId}:${sg.policyId}:${address.toLowerCase()}`;
        try {
          if (window.localStorage.getItem(k)) continue;
        } catch {
          /* */
        }
        try {
          await addSigners({ address, signers: [{ signerId: sg.signerId, policyIds: [sg.policyId] }] });
          window.localStorage.setItem(k, "1");
        } catch (e: any) {
          // Already added counts as done; anything else retries on the next visit.
          if (/already|duplicate/i.test(String(e?.message ?? ""))) window.localStorage.setItem(k, "1");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, me?.siweSigner?.signerId, me?.siweSigner?.policyId, privyWallets?.length, user?.linkedAccounts?.length]); // eslint-disable-line
  const connectPrivy = useCallback(() => login({ loginMethods: ["telegram"] } as any), [login]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        if (authenticated) {
          const token = await getAccessToken();
          const idToken = await idTokenOrNull();
          const r = await api("/api/me", { token, idToken });
          if (cancelled) return;
          setMe(r);
          setTgOnly(false);
          setErr(null);
          saveTimeZone(r?.user?.timezone, { token, idToken });
          return;
        }
        // Mini App: Privy's seamless Telegram login didn't sign us in → verified-initData SkyBOT session (fallback).
        if (isMiniApp && initData) {
          const sess = await api<{ ok: boolean; user: any }>("/api/telegram/session", { body: { initData } });
          if (cancelled) return;
          setMe({ user: sess.user, authVia: "telegram-session" });
          setTgOnly(true);
          saveTimeZone(sess.user?.timezone, {});
          return;
        }
        if (!isMiniApp) login();
      } catch (e: any) {
        if (!cancelled) setErr(e.message);
      }
    };
    // Give Privy a moment to finish seamless Mini App auth before falling back.
    if (!authenticated && isMiniApp) timer = setTimeout(run, SEAMLESS_WAIT_MS);
    else void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ready, authenticated, isMiniApp, initData]); // eslint-disable-line

  useEffect(() => {
    if (!webApp || !isMiniApp) return;
    const onBack = () => {
      if (path !== "/app/mint") router.push("/app/mint");
      else webApp.close();
    };
    webApp.BackButton.show();
    webApp.BackButton.onClick(onBack);
    return () => {
      webApp.BackButton.offClick(onBack);
      webApp.BackButton.hide();
    };
  }, [webApp, isMiniApp, path, router]);

  if (!ready)
    return (
      <div className="hero">
        <p className="muted">Loading…</p>
      </div>
    );
  if (!authenticated && !tgOnly) {
    return (
      <div className="hero">
        <p className="muted">{err ?? (isMiniApp ? "Signing you in with Telegram…" : "Signing you in…")}</p>
        <button onClick={() => (isMiniApp ? connectPrivy() : login())}>{isMiniApp ? "Sign In with Telegram" : "Sign In"}</button>
      </div>
    );
  }

  const nav = [
    { href: "/app/mint", label: "Mint" },
    { href: "/app/wallets", label: "Wallets" },
    { href: "/app/withdraw", label: "Withdraw" },
    { href: "/app/jobs", label: "Jobs" },
    { href: "/app/settings", label: "Settings" },
    ...(me?.user?.role === "admin" ? [{ href: "/app/admin", label: "Admin" }] : []),
  ];

  return (
    <>
      <nav className="shell-nav">
        <Link href="/" className="brand">
          <img src="/logo.png" alt="" /> SkyBOT Mint
        </Link>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? "active" : ""}>
            {n.label}
          </Link>
        ))}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 13 }}>
          {me?.user?.email ?? user?.email?.address ?? (me?.user?.telegramUsername ? `@${me.user.telegramUsername}` : "signed in")}
        </span>
        {!tgOnly && !isMiniApp && (
          <button
            className="ghost"
            onClick={() => {
              clearWalletCache();
              logout().then(() => router.push("/"));
            }}
          >
            Sign Out
          </button>
        )}
      </nav>
      <main className="app">
        {tgOnly && (
          <div className="notice row" style={{ justifyContent: "space-between" }}>
            <span>Signed in with Telegram. Connect with Privy to import or generate wallets.</span>
            <button onClick={connectPrivy}>Connect with Privy</button>
          </div>
        )}
        {err && authenticated && <div className="err">{err}</div>}
        <ShellCtx.Provider value={{ tgOnly, connectPrivy, userId: me?.user?.id ?? null }}>{children}</ShellCtx.Provider>
      </main>
    </>
  );
}

export function useApi() {
  const { getAccessToken, authenticated } = usePrivy();
  const { initData } = useTelegram();
  // Stable identity across renders: pages use it in effect/useCallback deps (an unstable fn caused request loops).
  return useCallback(
    async function call<T = any>(path: string, opts: { method?: string; body?: unknown } = {}) {
      const token = authenticated ? await getAccessToken() : null;
      const idToken = token ? await idTokenOrNull() : null;
      // Prefer Privy token; otherwise the httpOnly session cookie carries auth (initData header only as last resort).
      return api<T>(path, { ...opts, token, idToken, telegramInitData: token ? null : initData });
    },
    [authenticated, getAccessToken, initData],
  );
}
