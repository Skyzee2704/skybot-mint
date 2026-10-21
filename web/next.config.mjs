const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:4000";
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Local / same-origin proxy. On Vercel set NEXT_PUBLIC_API_URL so the browser talks to Railway directly (CORS).
    if (process.env.NEXT_PUBLIC_API_URL) return [];
    return [{ source: "/api/:path*", destination: `${API_URL.replace(/\/$/, "")}/api/:path*` }];
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org https://*.privy.io https://challenges.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: blob: https:",
            "connect-src 'self' https: wss:",
            "frame-src https://telegram.org https://oauth.telegram.org https://*.privy.io https://auth.privy.io https://challenges.cloudflare.com",
            "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
          ].join("; "),
        },
      ],
    }];
  },
};
export default nextConfig;
