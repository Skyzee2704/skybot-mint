"use client";

const API_BASE = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL
  ? process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "")
  : "");

function url(path: string) {
  if (path.startsWith("http")) return path;
  return `${API_BASE}${path.startsWith("/") ? path : "/" + path}`;
}

export async function api<T = any>(path: string, opts: {
  method?: string; body?: unknown; token?: string | null; idToken?: string | null; telegramInitData?: string | null;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idToken) headers["privy-id-token"] = opts.idToken;
  if (opts.telegramInitData) headers["x-telegram-init-data"] = opts.telegramInitData;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url(path), {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function fmtEth(wei: string | null | undefined, digits = 6) {
  if (wei === null || wei === undefined) return "?";
  const n = BigInt(wei); const neg = n < 0n; const a = neg ? -n : n;
  const whole = a / 10n ** 18n; const frac = (a % 10n ** 18n).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
