"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTelegram } from "@/lib/telegram";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { isMiniApp, initData, webApp } = useTelegram();
  const [me, setMe] = useState<any>(null);
  const [tgOnly, setTgOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        if (authenticated) {
          const token = await getAccessToken();
          const idToken = await (user as any)?.getIdentityToken?.().catch?.(() => null);
          setMe(await api("/api/me", { token, idToken, telegramInitData: initData }));
          setTgOnly(false);
          return;
        }
        // Mini App: Privy Telegram seamless login didn't sign us in → verified-initData SkyBOT session (Telegram-first account).
        if (isMiniApp && initData) {
          const sess = await api<{ ok: boolean; user: any }>("/api/telegram/session", { body: { initData } });
          setMe({ user: sess.user, authVia: "telegram-session" });
          setTgOnly(true);
          return;
        }
        if (!isMiniApp) login();
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, [ready, authenticated, isMiniApp, initData]); // eslint-disable-line

  useEffect(() => {
    if (!webApp || !isMiniApp) return;
    const onBack = () => {
      if (path !== "/app/mint") router.push("/app/mint");
      else webApp.close();
    };
    webApp.BackButton.show();
    webApp.BackButton.onClick(onBack);
    return () => { webApp.BackButton.offClick(onBack); webApp.BackButton.hide(); };
  }, [webApp, isMiniApp, path, router]);

  if (!ready) return <div className="hero"><p className="muted">Loading…</p></div>;
  if (!authenticated && !tgOnly) {
    return (
      <div className="hero">
        <p className="muted">{err ?? (isMiniApp ? "Open Settings on the web to Connect Telegram, or sign in." : "Signing you in…")}</p>
        <button onClick={login}>Sign in</button>
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
        <Link href="/" className="brand"><img src="/logo.png" alt="" /> SkyBOT Mint</Link>
        {nav.map((n) => <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? "active" : ""}>{n.label}</Link>)}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 13 }}>{me?.user?.email ?? user?.email?.address ?? (tgOnly ? `@${me?.user?.telegramUsername ?? "tg"}` : "signed in")}</span>
        {!tgOnly && !isMiniApp && <button className="ghost" onClick={() => logout().then(() => router.push("/"))}>Sign out</button>}
      </nav>
      <main className="app">{children}</main>
    </>
  );
}

export function useApi() {
  const { getAccessToken, user, authenticated } = usePrivy();
  const { initData } = useTelegram();
  return async function call<T = any>(path: string, opts: { method?: string; body?: unknown } = {}) {
    const token = authenticated ? await getAccessToken() : null;
    const idToken = await (user as any)?.getIdentityToken?.().catch?.(() => null);
    // Prefer Privy token; otherwise the httpOnly session cookie carries auth (initData header only as last resort).
    return api<T>(path, { ...opts, token, idToken, telegramInitData: token ? null : initData });
  };
}
