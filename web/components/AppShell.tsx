"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getIdentityToken, usePrivy } from "@privy-io/react-auth";
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { isMiniApp, initData, webApp } = useTelegram();
  const [me, setMe] = useState<any>(null);
  const [tgOnly, setTgOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const path = usePathname();
  const router = useRouter();
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
          return;
        }
        // Mini App: Privy's seamless Telegram login didn't sign us in → verified-initData SkyBOT session (fallback).
        if (isMiniApp && initData) {
          const sess = await api<{ ok: boolean; user: any }>("/api/telegram/session", { body: { initData } });
          if (cancelled) return;
          setMe({ user: sess.user, authVia: "telegram-session" });
          setTgOnly(true);
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
