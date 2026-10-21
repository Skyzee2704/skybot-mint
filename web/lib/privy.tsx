"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { PrivyProvider } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useTelegram } from "./telegram";
import { DEFAULT_PRIVY_CHAIN, PRIVY_CHAINS } from "./privyChains";

const PUBLIC_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

export function SkyPrivyProvider({ children }: { children: React.ReactNode }) {
  const [appId, setAppId] = useState<string | null>(PUBLIC_APP_ID || null);
  const [ready, setReady] = useState(Boolean(PUBLIC_APP_ID));
  const [setup, setSetup] = useState<any>(null);
  const { isMiniApp } = useTelegram();

  useEffect(() => {
    if (PUBLIC_APP_ID) {
      setReady(true);
      return;
    }
    api<{ privyConfigured: boolean; privyAppId: string | null; setup: any }>("/api/status")
      .then((s) => {
        setAppId(s.privyAppId);
        setSetup(s.setup);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  if (!ready)
    return (
      <div className="hero">
        <p className="muted">Loading SkyBOT…</p>
      </div>
    );
  if (!appId) {
    return (
      <div className="hero">
        <div className="hero-inner">
          <img src="/logo.png" alt="" className="hero-logo" />
          <h1>
            SkyBOT <span>Mint</span>
          </h1>
          <div className="setup-banner">
            <b>Privy setup required</b>
            <p className="muted">
              Set <code>PRIVY_APP_ID</code> / <code>NEXT_PUBLIC_PRIVY_APP_ID</code> and <code>PRIVY_APP_SECRET</code>.
            </p>
            {setup?.steps && (
              <ol style={{ textAlign: "left" }}>
                {setup.steps.map((s: string) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    );
  }

  // One identity everywhere: Telegram, email and Google all resolve to the same Privy user (and SkyBOT account).
  // Telegram first inside the Mini App. No wallet login.
  const loginMethods = isMiniApp ? (["telegram", "email", "google"] as const) : (["email", "google", "telegram"] as const);

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: [...loginMethods] as any,
        appearance: {
          theme: "dark",
          accentColor: "#FF6B1A",
          logo: "/logo.png",
          landingHeader: "Welcome to SkyBOT Mint",
        },
        // All SkyBOT chains (incl. Ink, Robinhood, Arc, which are not in Privy's defaults): without this,
        // signing on those chains never resolves.
        supportedChains: PRIVY_CHAINS,
        defaultChain: DEFAULT_PRIVY_CHAIN,
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
