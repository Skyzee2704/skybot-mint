/** Dashboard proxies /api/* to the backend so the browser only talks to one origin. */
const API_URL = process.env.API_URL || "http://127.0.0.1:4000";
export default {
  reactStrictMode: true,
  async rewrites() { return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }]; },
};
