"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type TgWebApp = {
  initData: string;
  initDataUnsafe: { user?: { id: number; username?: string }; start_param?: string };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  close: () => void;
  HapticFeedback?: { impactOccurred: (s: string) => void; notificationOccurred: (s: string) => void };
  MainButton: {
    text: string;
    isVisible: boolean;
    isActive: boolean;
    isProgressVisible: boolean;
    setText: (t: string) => void;
    show: () => void;
    hide: () => void;
    enable: () => void;
    disable: () => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
    setParams: (p: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
  };
  BackButton: {
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  setHeaderColor: (c: string) => void;
  setBackgroundColor: (c: string) => void;
  setBottomBarColor?: (c: string) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

type Ctx = {
  isMiniApp: boolean;
  initData: string | null;
  webApp: TgWebApp | null;
  haptic: (kind?: "light" | "medium" | "heavy" | "success" | "error") => void;
};

const TelegramCtx = createContext<Ctx>({ isMiniApp: false, initData: null, webApp: null, haptic: () => {} });

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [webApp, setWebApp] = useState<TgWebApp | null>(null);

  useEffect(() => {
    const boot = () => {
      const wa = window.Telegram?.WebApp;
      if (!wa?.initData) return;
      wa.ready();
      wa.expand();
      try {
        wa.setHeaderColor("#070707");
        wa.setBackgroundColor("#070707");
        // The app never uses Telegram's bottom MainButton (it sits below our own tab bar); keep it hidden and the
        // bottom bar dark so no light strip appears under the page.
        wa.MainButton.hide();
        wa.setBottomBarColor?.("#070707");
      } catch {
        /* older clients */
      }
      document.documentElement.classList.add("tg-mini-app");
      setWebApp(wa);
    };
    if (window.Telegram?.WebApp) boot();
    else {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js";
      s.async = true;
      s.onload = () => boot();
      document.head.appendChild(s);
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      isMiniApp: Boolean(webApp?.initData),
      initData: webApp?.initData || null,
      webApp,
      haptic: (kind = "light") => {
        try {
          if (kind === "success" || kind === "error") webApp?.HapticFeedback?.notificationOccurred(kind);
          else webApp?.HapticFeedback?.impactOccurred(kind);
        } catch {
          /* */
        }
      },
    }),
    [webApp],
  );

  return <TelegramCtx.Provider value={value}>{children}</TelegramCtx.Provider>;
}

export function useTelegram() {
  return useContext(TelegramCtx);
}
