"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { usePathname, useRouter } from "next/navigation";
import { getIdentityToken, usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import { localTimeZone } from "@/lib/time";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { telegramBotUsername, useTelegram } from "@/lib/telegram";
import { clearWalletCache } from "@/lib/wallets";
import { clearSwrCache, prefetchMenus, setCacheScope } from "@/lib/swr";
import { ShellNav } from "./ShellNav";

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
  // Two signers are added silently to each embedded wallet with the member's own Privy session (Privy only lets the
  // wallet owner add them): the sign-in-only signer (Privy policy allows personal_sign of OpenSea's login text only)
  // so the Telegram /check can verify upcoming OpenSea stages, and the mint signer so scheduled mints can be signed
  // by the server. The server says which wallets already have each one, the app adds the rest (one call per wallet,
  // so the signer list is never rewritten concurrently), then the server re-verifies with Privy. Never blocks or
  // shows errors.
  const sgKey = [me?.siweSigner, me?.mintSigner]
    .map((sg: any) =>
      sg
        ? `${sg.signerId}:${sg.policyId ?? ""}:a${sg.attached?.length ?? "?"}:m${sg.missing?.length ?? "?"}:u${(sg as any).upgrade?.length ?? 0}`
        : "",
    )
    .join("|");
  useEffect(() => {
    const cfgs = (
      [
        [me?.siweSigner, "/api/wallets/siwe-signer/verify", true],
        [me?.mintSigner, "/api/wallets/mint-signer/verify", false],
      ] as const
    ).filter(([sg, , needsPolicy]) => sg?.signerId && (!needsPolicy || sg?.policyId));
    if (!authenticated || !cfgs.length) return;
    // Every Privy embedded EVM wallet of this user: linked accounts (generated, imported, server-created) + connected.
    const addrs = new Set<string>();
    for (const a of (user?.linkedAccounts ?? []) as any[]) {
      if (a?.type === "wallet" && a?.walletClientType === "privy" && (a?.chainType ?? "ethereum") === "ethereum" && a?.address) {
        addrs.add(String(a.address));
      }
    }
    for (const w of privyWallets ?? []) if (w.walletClientType === "privy") addrs.add(w.address);
    const plan = [...addrs]
      .map((address) => ({
        address,
        signers: cfgs
          // Skip wallets already attached with the right policy. Re-add "upgrade" (signer present, wrong/missing
          // policy) and "missing" so PRIVY_MINT_POLICY_ID gets applied. After verify moves them to attached,
          // sgKey changes and this effect won't re-add them (no loop).
          .filter(([sg]) => {
            const lc = address.toLowerCase();
            const attached = ((sg.attached as string[] | null) ?? []).some((x) => x.toLowerCase() === lc);
            if (attached) return false;
            const upgrade = (((sg as any).upgrade as string[] | undefined) ?? []).some((x) => x.toLowerCase() === lc);
            // Upgrade only when a policy id is configured to apply; otherwise treat as already usable.
            if (upgrade && !sg.policyId) return false;
            return true; // missing, or upgrade with policyId
          })
          .map(([sg, verify]) => ({ signerId: String(sg.signerId), policyIds: sg.policyId ? [String(sg.policyId)] : [], verify })),
      }))
      .filter((p) => p.signers.length);
    if (!plan.length) return;
    let cancelled = false;
    (async () => {
      const verify = new Set<string>();
      // Sequential: each call reads then rewrites the wallet's signer list, so parallel calls could race.
      for (const p of plan) {
        if (cancelled) return;
        const add = async (list: typeof p.signers) => {
          try {
            await addSigners({ address: p.address, signers: list.map(({ signerId, policyIds }) => ({ signerId, policyIds })) });
            list.forEach((x) => verify.add(x.verify));
            return true;
          } catch (e: any) {
            // Already present counts as done; anything else retries on the next visit.
            if (/already|duplicate|exists/i.test(String(e?.message ?? ""))) list.forEach((x) => verify.add(x.verify));
            return false;
          }
        };
        // Both in one call; if that fails, one at a time so one signer can't hold the other back.
        if (!(await add(p.signers)) && p.signers.length > 1) for (const x of p.signers) if (!cancelled) await add([x]);
      }
      if (verify.size && !cancelled) {
        try {
          const token = await getAccessToken();
          for (const path of verify) await api(path, { method: "POST", body: {}, token });
        } catch {
          /* best effort */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, sgKey, privyWallets?.length, user?.linkedAccounts?.length]);
  const connectPrivy = useCallback(() => login({ loginMethods: ["telegram"] } as any), [login]);

  // Per-user client cache + warm Wallets / NFTs once per sign-in (deduped with the pages' own requests).
  const shellApi = useApi();
  const meId: string | null = me?.user?.id ?? null;
  useEffect(() => {
    if (!meId) return;
    setCacheScope(meId);
    prefetchMenus(shellApi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId]);

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

  const account = me?.user?.email ?? user?.email?.address ?? (me?.user?.telegramUsername ? `@${me.user.telegramUsername}` : "Signed in");

  return (
    <>
      <ShellNav
        path={path}
        isAdmin={me?.user?.role === "admin"}
        botUsername={telegramBotUsername() ?? me?.botUsername ?? null}
        account={account}
        onSignOut={
          !tgOnly && !isMiniApp
            ? () => {
                clearWalletCache();
                clearSwrCache();
                logout().then(() => router.push("/"));
              }
            : undefined
        }
      />
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
