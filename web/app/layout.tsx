// SPDX-License-Identifier: AGPL-3.0-only
import "../lib/theme.css";
import { SkyPrivyProvider } from "@/lib/privy";
import { TelegramProvider } from "@/lib/telegram";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { SiteFooter } from "@/components/SiteFooter";

const DEFAULT_SITE_URL = "https://skybotmint.web.id";

/** Public site origin for absolute link-preview URLs. Local / non-https values fall back to production. */
function siteUrl(): URL {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  for (const raw of [process.env.NEXT_PUBLIC_SITE_URL, process.env.PUBLIC_URL, vercel ? `https://${vercel}` : ""]) {
    try {
      const u = new URL(String(raw ?? "").trim());
      if (u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname)) return new URL(u.origin);
    } catch {
      /* not set / not a URL */
    }
  }
  return new URL(DEFAULT_SITE_URL);
}

const SITE = siteUrl();
const TITLE = "SkyBOT Mint";
const DESCRIPTION =
  "SkyBOT Mint resolves any OpenSea drop or contract from a link, checks every wallet for allowlist and balance, simulates gas, then mints across your fleet — on web or Telegram.";
/** Static 1200×630 preview (web/scripts/og-image.mjs). Bump ?v= when the image changes so X/Discord refetch it. */
const OG_IMAGE = { url: "/og.png?v=2", width: 1200, height: 630, type: "image/png", alt: "SkyBOT Mint — Mint faster. Miss less." };

export const metadata: Metadata = {
  metadataBase: SITE,
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    siteName: TITLE,
    title: `${TITLE} — Mint faster. Miss less.`,
    description: DESCRIPTION,
    url: "/",
    locale: "en_US",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} — Mint faster. Miss less.`,
    description: DESCRIPTION,
    images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#070707",
  viewportFit: "cover",
};

/** Mark the Mini App before first paint (Telegram passes tgWebApp* in the URL hash) so the mobile nav never flashes. */
const MINI_APP_EARLY = `try{var h=location.hash||"";if(/tgWebApp(Data|Version|Platform)=/.test(h)){sessionStorage.setItem("skybot-tg","1")}if(sessionStorage.getItem("skybot-tg")==="1"){document.documentElement.classList.add("tg-mini-app")}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MINI_APP_EARLY }} />
      </head>
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
