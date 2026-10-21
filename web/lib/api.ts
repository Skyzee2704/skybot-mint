"use client";
/** Browser API client. Only an opaque session token is stored (sessionStorage); never keys. */
const TOKEN_KEY = "nmb_session";
export const getToken = () => (typeof window === "undefined" ? null : sessionStorage.getItem(TOKEN_KEY));
export const setToken = (t: string | null) => { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { setToken(null); window.dispatchEvent(new Event("nmb:locked")); }
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
