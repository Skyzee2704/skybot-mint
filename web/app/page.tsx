"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useTelegram } from "@/lib/telegram";

/** Public landing page. Always reachable, signed in or not (no redirect); signed-in users get "Open Dashboard". */
export default function Landing() {
  const { ready, authenticated, login } = usePrivy();
  const { isMiniApp } = useTelegram();
  // Inside Telegram the dashboard signs in with Telegram automatically, so the landing just links to it.
  const signedIn = ready && (authenticated || isMiniApp);

  return (
    <div className="hero">
      <div className="hero-inner">
        <img src="/logo.png" alt="SkyBOT" className="hero-logo" />
        <p className="pill accent" style={{ margin: "18px auto" }}>
          Community Mint Desk
        </p>
        <h1>
          Mint faster.
          <br />
          <span>Miss less.</span>
        </h1>
        <p className="lead">
          SkyBOT Mint resolves any OpenSea drop or contract from a link, checks every wallet for allowlist and balance, simulates gas, then
          mints across your fleet — on web or Telegram.
        </p>
        <div className="row" style={{ justifyContent: "center", minHeight: 44 }}>
          {!ready ? (
            <span className="skeleton" style={{ width: 220, height: 40 }} />
          ) : signedIn ? (
            <Link className="btn" href="/app/mint">
              Open Dashboard
            </Link>
          ) : (
            <>
              <button onClick={login}>Sign In with Email or Google</button>
              <Link className="btn ghost" href="/app/mint">
                Enter App
              </Link>
            </>
          )}
        </div>
        <div className="features">
          <div className="card">
            <h3>OpenSea + Any Contract</h3>
            <p className="muted">SeaDrop public &amp; signed stages via the official API, plus generic verified ABIs on 9 chains.</p>
          </div>
          <div className="card">
            <h3>Allowlist Without Funding</h3>
            <p className="muted">
              Know who&apos;s on the list before you top up. Fake-balance simulation and OpenSea ordering keep checks honest.
            </p>
          </div>
          <div className="card">
            <h3>Your Keys, Privy Custody</h3>
            <p className="muted">
              Embedded HD wallets and imports live with Privy. SkyBOT never stores private keys — scheduled mints use session signers.
            </p>
          </div>
          <div className="card">
            <h3>Telegram Twin</h3>
            <p className="muted">
              Open SkyBOT inside Telegram with the same account. /check any drop for every wallet&apos;s eligibility and get notified when
              mints land.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
