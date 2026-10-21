// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Telegram Mini App helpers: initData HMAC validation + PUBLIC_URL gate.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

export function publicHttpsReady(url = env.publicUrl): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return false;
    return true;
  } catch {
    return false;
  }
}

export type TelegramWebAppUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
  is_premium?: boolean;
};

export type ValidatedInitData = {
  user: TelegramWebAppUser;
  authDate: number;
  queryId?: string;
  startParam?: string;
  raw: Record<string, string>;
};

/** Validate Telegram WebApp initData. Throws on failure. */
export function validateInitData(initData: string, maxAgeSec = 86400): ValidatedInitData {
  const token = env.telegramBotToken;
  if (!token) throw Object.assign(new Error("Telegram bot not configured"), { statusCode: 503 });
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw Object.assign(new Error("Missing initData hash"), { statusCode: 401 });
  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Invalid Telegram initData signature"), { statusCode: 401 });
  }
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) {
    throw Object.assign(new Error("Telegram initData expired — reopen the Mini App"), { statusCode: 401 });
  }
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    throw Object.assign(new Error("Malformed Telegram user in initData"), { statusCode: 401 });
  }
  if (!user?.id) throw Object.assign(new Error("No Telegram user in initData"), { statusCode: 401 });
  const raw: Record<string, string> = {};
  for (const [k, v] of entries) raw[k] = v;
  return {
    user,
    authDate,
    queryId: params.get("query_id") ?? undefined,
    startParam: params.get("start_param") ?? undefined,
    raw,
  };
}
