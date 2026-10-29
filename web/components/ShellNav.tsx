"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * App navigation. Desktop: sticky top bar with orange active pill. Phones and the Telegram Mini App: compact top bar
 * (brand + account chip) and a fixed bottom tab bar (Mint, Wallets, NFTs, Withdraw, More) whose "More" opens a bottom
 * sheet with the secondary pages. Both layouts are always rendered and CSS picks one, so there is no layout shift.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { telegramBotLinkProps, telegramBotUsername, useTelegram } from "@/lib/telegram";
import {
  ArrowUpRight,
  ImageIcon,
  ListChecks,
  LogOut,
  Menu,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon };

const PRIMARY: Item[] = [
  { href: "/app/mint", label: "Mint", icon: Sparkles },
  { href: "/app/wallets", label: "Wallets", icon: Wallet },
  { href: "/app/nfts", label: "NFTs", icon: ImageIcon },
  { href: "/app/withdraw", label: "Withdraw", icon: ArrowUpRight },
];
const SECONDARY: Item[] = [
  { href: "/app/jobs", label: "Jobs", icon: ListChecks },
  { href: "/app/settings", label: "Settings", icon: Settings },
];
const ADMIN: Item = { href: "/app/admin", label: "Admin", icon: ShieldCheck };

const isActive = (path: string, href: string) => path === href || path.startsWith(href + "/");

export function ShellNav(props: {
  path: string;
  isAdmin: boolean;
  account: string;
  onSignOut?: () => void;
  /** Override the bot username (defaults to NEXT_PUBLIC_TELEGRAM_BOT_USERNAME); the link hides when there is none. */
  botUsername?: string | null;
}) {
  const { path, isAdmin, account, onSignOut } = props;
  const [sheet, setSheet] = useState(false);
  const secondary = isAdmin ? [...SECONDARY, ADMIN] : SECONDARY;
  const desktop = [PRIMARY[0], PRIMARY[1], PRIMARY[3], PRIMARY[2], ...secondary];
  const moreActive = secondary.some((i) => isActive(path, i.href));
  const initial = (account.replace(/^@/, "")[0] ?? "?").toUpperCase();
  const { webApp } = useTelegram();
  const bot = props.botUsername === undefined ? telegramBotUsername() : telegramBotUsername(props.botUsername ?? "");
  const botLink = bot ? telegramBotLinkProps(bot, webApp) : null;

  // Close the sheet on navigation and on Escape.
  useEffect(() => setSheet(false), [path]);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  return (
    <>
      {/* Desktop */}
      <nav className="shell-nav" aria-label="Main">
        <Link href="/" className="brand">
          <img src="/logo.png" alt="" /> SkyBOT Mint
        </Link>
        {desktop.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={isActive(path, n.href) ? "active" : ""}
            aria-current={isActive(path, n.href) ? "page" : undefined}
          >
            {n.label}
          </Link>
        ))}
        <span className="spacer" />
        {botLink && (
          <a {...botLink} className="tg-bot-link" title={`Open @${bot} in Telegram`}>
            <Send size={15} aria-hidden /> Telegram Bot
          </a>
        )}
        <span className="account-chip" title={account}>
          <span className="avatar" aria-hidden>
            {initial}
          </span>
          <span className="name">{account}</span>
        </span>
        {onSignOut && (
          <button className="ghost" onClick={onSignOut}>
            Sign Out
          </button>
        )}
      </nav>

      {/* Phone / Mini App */}
      <header className="m-top">
        <Link href="/app/mint" className="brand">
          <img src="/logo.png" alt="" /> <span>SkyBOT Mint</span>
        </Link>
        <span className="account-chip" title={account}>
          <span className="avatar" aria-hidden>
            {initial}
          </span>
          <span className="name">{account}</span>
        </span>
      </header>
      <nav className="tabbar" aria-label="Main">
        {PRIMARY.map((n) => {
          const on = isActive(path, n.href);
          const Icon = n.icon;
          return (
            <Link key={n.href} href={n.href} className={on ? "tab active" : "tab"} aria-current={on ? "page" : undefined}>
              <Icon size={22} strokeWidth={on ? 2.4 : 1.9} aria-hidden />
              <span>{n.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={moreActive || sheet ? "tab active" : "tab"}
          aria-haspopup="dialog"
          aria-expanded={sheet}
          onClick={() => setSheet((s) => !s)}
        >
          <Menu size={22} strokeWidth={moreActive || sheet ? 2.4 : 1.9} aria-hidden />
          <span>More</span>
        </button>
      </nav>
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="More" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <b>More</b>
              <button type="button" className="sheet-close" aria-label="Close" onClick={() => setSheet(false)}>
                <X size={20} aria-hidden />
              </button>
            </div>
            {secondary.map((n) => {
              const on = isActive(path, n.href);
              const Icon = n.icon;
              return (
                <Link key={n.href} href={n.href} className={on ? "sheet-item active" : "sheet-item"} aria-current={on ? "page" : undefined}>
                  <Icon size={20} aria-hidden />
                  <span>{n.label}</span>
                </Link>
              );
            })}
            {botLink && (
              <a {...botLink} className="sheet-item">
                <Send size={20} aria-hidden />
                <span>Telegram Bot</span>
                <span className="muted small" style={{ marginLeft: "auto" }}>
                  @{bot}
                </span>
              </a>
            )}
            {onSignOut && (
              <button type="button" className="sheet-item signout" onClick={onSignOut}>
                <LogOut size={20} aria-hidden />
                <span>Sign Out</span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
