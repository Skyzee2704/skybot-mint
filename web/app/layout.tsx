// SPDX-License-Identifier: AGPL-3.0-only
import "../lib/theme.css";
import { SkyPrivyProvider } from "@/lib/privy";
import { TelegramProvider } from "@/lib/telegram";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "SkyBOT Mint",
  description: "Mint OpenSea drops and any NFT contract — for the community.",
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#070707",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        <TelegramProvider>
          <SkyPrivyProvider>{children}</SkyPrivyProvider>
          <SiteFooter />
        </TelegramProvider>
      </body>
    </html>
  );
}
