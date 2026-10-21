// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Short-lived SkyBOT session for Telegram-first logins (Mini App fallback when Privy Telegram login is off).
 * Token = v1.<userId>.<expSec>.<hmac-sha256>, delivered ONLY as an httpOnly; Secure; SameSite=None cookie.
 * Cookie-authenticated writes also require the X-SkyBOT-CSRF header (custom header => CORS preflight => blocked cross-origin).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export const SESSION_COOKIE = "sb_session";
export const SESSION_TTL_SEC = 60 * 60; // 1h

let secret: Buffer | null = null;
function key(): Buffer {
  if (secret) return secret;
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) return (secret = Buffer.from(fromEnv));
  const file = path.join(env.dataDir, "session.key");
  try {
    secret = fs.readFileSync(file);
  } catch {
    fs.mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });
    secret = randomBytes(48);
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret!;
}

const mac = (s: string) => createHmac("sha256", key()).update(s).digest("base64url");

export function signSession(userId: string, ttlSec = SESSION_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `v1.${Buffer.from(userId).toString("base64url")}.${exp}`;
  return { token: `${body}.${mac(body)}`, exp };
}

export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const body = parts.slice(0, 3).join(".");
  const a = Buffer.from(mac(body));
  const b = Buffer.from(parts[3]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(parts[2]) < Date.now() / 1000) return null;
  try {
    return Buffer.from(parts[1], "base64url").toString();
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const p of header.split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SEC) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=None; Max-Age=0`;
