// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPrivyAccessToken } from "./privy.js";
import { privyConfigured } from "../config/env.js";
import {
  resolvePrivyUser,
  userByPrivyId,
  touchPrivyUser,
  checkRateLimit,
  userByTelegram,
  profileFromPrivyUser,
  isAdminIdentity,
  syncRole,
  type AppUser,
  type PrivyProfile,
} from "../users/service.js";
import { validateInitData } from "../bot/telegramWebApp.js";
import { readCookie, verifySession } from "./session.js";
import { requireUser } from "../users/service.js";
import { log, redactString } from "../util/log.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AppUser;
    privyAccessToken?: string;
    authVia?: "privy" | "telegram-session" | "telegram-init";
  }
}

/** Extract Bearer token. Never log it. */
export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/**
 * Linked accounts for a verified Privy user. Prefers the identity token (verified locally, no API call);
 * otherwise fetches from the Privy API only the first time we see this Privy id, so a Telegram-linked
 * Privy login can be matched to an existing Telegram-first SkyBOT account.
 */
async function privyProfileFor(privyUserId: string, idToken: string | undefined, known: boolean): Promise<PrivyProfile> {
  const { getPrivy } = await import("./privy.js");
  if (idToken) {
    try {
      const u = await getPrivy().utils().auth().verifyIdentityToken(idToken);
      if ((u as any)?.id === privyUserId) return profileFromPrivyUser(u as any);
    } catch {
      /* identity token is optional */
    }
  }
  if (known) return {};
  try {
    return profileFromPrivyUser((await getPrivy().users()._get(privyUserId)) as any);
  } catch (e: any) {
    log.warn("privy user lookup failed", redactString(String(e?.message ?? e)).slice(0, 160));
    return {};
  }
}

/**
 * Authenticate private routes:
 * 1) Privy access token (primary)
 * 2) SkyBOT session cookie (Telegram-first)
 * 3) Fallback: X-Telegram-Init-Data HMAC → linked SkyBOT user (Mini App without Privy Telegram login)
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = bearer(req);
  if (token && privyConfigured()) {
    try {
      const claims = await verifyPrivyAccessToken(token);
      // One lookup for the common case (returning user); full resolution only for first logins.
      const known = await userByPrivyId(claims.privyUserId);
      const profile = await privyProfileFor(claims.privyUserId, req.headers["privy-id-token"] as string | undefined, Boolean(known));
      const user = known ? await touchPrivyUser(known, profile) : await resolvePrivyUser(claims.privyUserId, profile);
      if (user.disabled) return reply.code(403).send({ error: "Account disabled" });
      await checkRateLimit(user.id, req.routeOptions.url ?? req.url.split("?")[0]);
      req.user = await syncRole(user);
      req.privyAccessToken = token;
      req.authVia = "privy";
      return;
    } catch (e: any) {
      // Account conflicts are a definitive answer, not an auth failure — surface them.
      if (e?.code === "ACCOUNT_CONFLICT" || e?.statusCode === 403 || e?.statusCode === 429)
        return reply.code(e.statusCode ?? 409).send({ error: e.message, code: e.code });
      log.warn("privy auth failed", redactString(String(e?.message ?? e)));
      // fall through to telegram session / initData
    }
  }

  // 2) SkyBOT session cookie (Telegram-first login). Writes need the CSRF header.
  const sid = verifySession(readCookie(req.headers.cookie));
  if (sid) {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe && req.headers["x-skybot-csrf"] !== "1") return reply.code(403).send({ error: "CSRF header missing" });
    try {
      const user = await requireUser(sid);
      await checkRateLimit(user.id, req.routeOptions.url ?? req.url.split("?")[0]);
      req.user = await syncRole(user);
      req.authVia = "telegram-session";
      return;
    } catch (e: any) {
      return reply.code(e.statusCode ?? 401).send({ error: e.message });
    }
  }

  const initData =
    (req.headers["x-telegram-init-data"] as string | undefined) ??
    (typeof (req.body as any)?.initData === "string" ? (req.body as any).initData : undefined);
  if (initData) {
    try {
      const v = validateInitData(initData);
      const user = await userByTelegram(String(v.user.id));
      if (!user) {
        return reply.code(401).send({
          error: "Telegram account not linked to SkyBOT yet. Open SkyBOT from the bot menu to sign in.",
          code: "TELEGRAM_NOT_LINKED",
          telegramUserId: String(v.user.id),
        });
      }
      if (user.disabled) return reply.code(403).send({ error: "Account disabled" });
      await checkRateLimit(user.id, req.routeOptions.url ?? req.url.split("?")[0]);
      req.user = await syncRole(user);
      req.authVia = "telegram-init";
      return;
    } catch (e: any) {
      log.warn("telegram initData auth failed", redactString(String(e?.message ?? e)));
      return reply.code(401).send({ error: e.message ?? "Invalid Telegram initData" });
    }
  }

  if (!privyConfigured()) {
    // No credentials at all → always 401 (never leak config state as a different status); hint for operators.
    return reply
      .code(401)
      .send({ error: "Authentication required (Privy is not configured on this server).", code: "PRIVY_NOT_CONFIGURED" });
  }
  return reply.code(401).send({ error: "Missing Authorization: Bearer <privy-access-token> (or X-Telegram-Init-Data in Mini App)" });
}

/** Admin gate: allow-list check on the authenticated identity (never the stored role alone). */
export async function adminGate(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user || !isAdminIdentity(req.user)) return reply.code(403).send({ error: "Admin only" });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  return adminGate(req, reply);
}
