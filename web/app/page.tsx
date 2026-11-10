"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Send } from "lucide-react";
import { telegramBotUsername, useIsWebBrowser, useTelegram } from "@/lib/telegram";
import { LangSwitch, useLang } from "@/lib/i18n";

/** Public landing page. Always reachable, signed in or not (no redirect); signed-in users get "Open Dashboard". */
export default function Landing() {
  const { ready, authenticated, login } = usePrivy();
  const { isMiniApp } = useTelegram();
  const { t } = useLang();
  // Inside Telegram the dashboard signs in with Telegram automatically, so the landing just links to it.
  const signedIn = ready && (authenticated || isMiniApp);
  // Telegram bot link: web browser only (hidden in the Mini App and until mounted, so it never flashes there).
  const isWeb = useIsWebBrowser();
  const bot = telegramBotUsername();
  const botLink =
    isWeb && bot ? (
      <a className="btn ghost" href={`https://t.me/${bot}`} target="_blank" rel="noopener noreferrer" title={`Open @${bot} in Telegram`}>
        <Send size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "-3px" }} /> {t("Open Telegram Bot")}
      </a>
    ) : null;

  return (
    <div className="hero">
      <div className="hero-inner">
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LangSwitch />
        </div>
        <img src="/logo.png" alt="SkyBOT" className="hero-logo" />
        <p className="pill accent" style={{ margin: "18px auto" }}>
          {t("Community Mint Desk")}
        </p>
        <h1>
          {t("Mint faster.")}
          <br />
          <span>{t("Miss less.")}</span>
        </h1>
        <p className="lead">
          {t(
            "SkyBOT Mint resolves any OpenSea drop or contract from a link, checks every wallet for allowlist and balance, simulates gas, then mints across your fleet — on web or Telegram.",
          )}
        </p>
        <div className="row" style={{ justifyContent: "center", minHeight: 44 }}>
          {!ready ? (
            <span className="skeleton" style={{ width: 220, height: 40 }} />
          ) : signedIn ? (
            <Link className="btn" href="/app/mint">
              {t("Open Dashboard")}
            </Link>
          ) : null}
          {ready && signedIn && botLink}
          {ready && !signedIn && (
            <>
              <button onClick={login}>{t("Sign In with Email or Google")}</button>
              <Link className="btn ghost" href="/app/mint">
                {t("Enter App")}
              </Link>
              {botLink}
            </>
          )}
        </div>
        <div className="features">
          <div className="card">
            <h3>{t("OpenSea + Any Contract")}</h3>
            <p className="muted">{t("SeaDrop public & signed stages via the official API, plus generic verified ABIs on 10 chains.")}</p>
          </div>
          <div className="card">
            <h3>{t("Allowlist Without Funding")}</h3>
            <p className="muted">
              {t("Know who's on the list before you top up. Fake-balance simulation and OpenSea ordering keep checks honest.")}
            </p>
          </div>
          <div className="card">
            <h3>{t("Your Keys, Privy Custody")}</h3>
            <p className="muted">
              {t(
                "Embedded HD wallets and imports live with Privy. SkyBOT never stores private keys — scheduled mints use session signers.",
              )}
            </p>
          </div>
          <div className="card">
            <h3>{t("Telegram Twin")}</h3>
            <p className="muted">
              {t(
                "Open SkyBOT inside Telegram with the same account. /check any drop for every wallet's eligibility and get notified when mints land.",
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
