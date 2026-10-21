"use client";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Landing() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  useEffect(() => { if (ready && authenticated) router.replace("/app/mint"); }, [ready, authenticated, router]);

  return (
    <div className="hero">
      <div className="hero-inner">
        <img src="/logo.png" alt="SkyBOT" className="hero-logo" />
        <p className="pill accent" style={{ margin: "18px auto" }}>Community mint desk</p>
        <h1>Mint faster.<br /><span>Miss less.</span></h1>
        <p className="tag">SkyBOT Mint resolves any OpenSea drop or contract from a link, checks every wallet for allowlist and balance, simulates gas, then mints across your fleet — on web or Telegram.</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button onClick={login} disabled={!ready}>{authenticated ? "Open app" : "Sign in with email or Google"}</button>
          <Link className="btn ghost" href="/app/mint">Enter app</Link>
        </div>
        <div className="features">
          <div className="card"><h3>OpenSea + any contract</h3><p className="muted">SeaDrop public &amp; signed stages via the official API, plus generic verified ABIs on 9 chains.</p></div>
          <div className="card"><h3>Allowlist without funding</h3><p className="muted">Know who&apos;s on the list before you top up. Fake-balance simulation and OpenSea ordering keep checks honest.</p></div>
          <div className="card"><h3>Your keys, Privy custody</h3><p className="muted">Embedded HD wallets and imports live with Privy. SkyBOT never stores private keys — scheduled mints use session signers.</p></div>
          <div className="card"><h3>Telegram twin</h3><p className="muted">Link once, then /mint a link from chat. Same account, same wallets, same jobs.</p></div>
        </div>
      </div>
    </div>
  );
}
