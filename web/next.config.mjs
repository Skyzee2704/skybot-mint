// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Local dev: read public values from the repo-root .env (gitignored). On Vercel, set them in Project Settings.
if (fs.existsSync(path.join(root, ".env"))) {
  const { config } = await import("dotenv");
  config({ path: path.join(root, ".env"), quiet: true });
}
// Only these values are inlined into the client bundle. Never add secrets here.
const publicEnv = {
  NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || "",
  NEXT_PUBLIC_SOURCE_URL: process.env.NEXT_PUBLIC_SOURCE_URL || "",
  NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || "",
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: publicEnv,
  // API lives in this app (app/api/*) — no proxy. Server package + native/db drivers stay external (traced, not bundled).
  serverExternalPackages: [
    "@nft-mint-bot/server",
    "@libsql/client",
    "libsql",
    "@electric-sql/pglite",
    "grammy",
    "fastify",
    "@fastify/helmet",
    "@fastify/cors",
  ],
  outputFileTracingRoot: root,
  // Admin-only Gallery media (served by /api/admin/gallery/media/:name, never from web/public).
  outputFileTracingIncludes: {
    "/api/\\[...path\\]": ["../server/assets/promo/**"],
  },
  outputFileTracingExcludes: {
    // Test-only / local-only DB drivers are never used on Vercel (Neon HTTP driver is used in production).
    "*": [
      "../node_modules/@electric-sql/pglite/**",
      "../node_modules/@libsql/**",
      "../node_modules/libsql/**",
      "../node_modules/@esbuild/**",
      "../node_modules/typescript/**",
      "../server/test/**",
      "../server/src/**",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org https://*.privy.io https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob:",
              "connect-src 'self' https: wss:",
              "frame-src https://telegram.org https://oauth.telegram.org https://*.privy.io https://auth.privy.io https://challenges.cloudflare.com",
              "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
            ].join("; "),
          },
        ],
      },
    ];
  },
};
export default nextConfig;
