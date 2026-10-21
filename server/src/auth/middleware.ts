import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPrivyAccessToken } from "./privy.js";
import { privyConfigured } from "../config/env.js";
import { upsertUserFromPrivy, checkRateLimit, userByTelegram, type AppUser } from "../users/service.js";
import { validateInitData } from "../bot/telegramWebApp.js";
import { readCookie, verifySession } from "./session.js";
import { requireUser } from "../users/service.js";
import { log, redactString } from "../util/log.js";

declare module "fastify" {
  interface FastifyRequest { user?: AppUser; privyAccessToken?: string; authVia?: "privy" | "telegram-session" | "telegram-init"; }
}

/** Extract Bearer token. Never log it. */
export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
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
      const idToken = (req.headers["privy-id-token"] as string | undefined) ?? undefined;
      let email: string | null = null; let name: string | null = null;
      if (idToken) {
        try {
          const { getPrivy } = await import("./privy.js");
          const u = await getPrivy().utils().auth().verifyIdentityToken(idToken);
          const emailAcc = (u.linked_accounts as any[])?.find((a) => a.type === "email");
          const google = (u.linked_accounts as any[])?.find((a) => a.type === "google_oauth");
          const tg = (u.linked_accounts as any[])?.find((a) => a.type === "telegram");
          email = emailAcc?.address ?? google?.email ?? null;
          name = google?.name ?? tg?.username ?? null;
        } catch { /* identity token optional */ }
      }
      const user = await upsertUserFromPrivy(claims.privyUserId, { email, name });
      if (user.disabled) return reply.code(403).send({ error: "Account disabled" });
      await checkRateLimit(user.id, req.routeOptions.url ?? req.url.split("?")[0]);
      req.user = user;
      req.privyAccessToken = token;
      req.authVia = "privy";
      return;
    } catch (e: any) {
      log.warn("privy auth failed", redactString(String(e?.message ?? e)));
      // fall through to telegram initData
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
      req.user = user; req.authVia = "telegram-session"; return;
    } catch (e: any) { return reply.code(e.statusCode ?? 401).send({ error: e.message }); }
  }

  const initData = (req.headers["x-telegram-init-data"] as string | undefined)
    ?? (typeof (req.body as any)?.initData === "string" ? (req.body as any).initData : undefined);
  if (initData) {
    try {
      const v = validateInitData(initData);
      const user = await userByTelegram(String(v.user.id));
      if (!user) {
        return reply.code(401).send({
          error: "Telegram account not linked to SkyBOT. Open Settings → Connect Telegram, or /link in the bot.",
          code: "TELEGRAM_NOT_LINKED",
          telegramUserId: String(v.user.id),
        });
      }
      if (user.disabled) return reply.code(403).send({ error: "Account disabled" });
      await checkRateLimit(user.id, req.routeOptions.url ?? req.url.split("?")[0]);
      req.user = user;
      req.authVia = "telegram-init";
      return;
    } catch (e: any) {
      log.warn("telegram initData auth failed", redactString(String(e?.message ?? e)));
      return reply.code(401).send({ error: e.message ?? "Invalid Telegram initData" });
    }
  }

  if (!privyConfigured()) {
    return reply.code(503).send({ error: "Privy is not configured. Set PRIVY_APP_ID and PRIVY_APP_SECRET.", code: "PRIVY_NOT_CONFIGURED" });
  }
  return reply.code(401).send({ error: "Missing Authorization: Bearer <privy-access-token> (or X-Telegram-Init-Data in Mini App)" });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" });
}
