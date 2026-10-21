// SPDX-License-Identifier: AGPL-3.0-only
import { eq, and, sql, desc } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { getDb } from "../db/client.js";
import { users, wallets, groups, settings, telegramLinks, jobs } from "../db/schema.js";
import { env } from "../config/env.js";
import { createPrivyWallets, getPrivy } from "../auth/privy.js";
import { privyConfigured } from "../config/env.js";
import { log } from "../util/log.js";

export type AppUser = typeof users.$inferSelect;
export type WalletRow = typeof wallets.$inferSelect;

const now = () => new Date().toISOString();

export type PrivyProfile = {
  email?: string | null;
  name?: string | null;
  /** Telegram account linked to the Privy user (from the identity token or the Privy API). */
  telegram?: { id: string; username?: string | null } | null;
};

/**
 * Admin is an allow-list, never a stored default: a user is admin ONLY when their verified Telegram id is in
 * TELEGRAM_USER_ID / ADMIN_TELEGRAM_IDS or their verified email is in ADMIN_EMAILS. The `role` column is kept
 * in sync for display, but every access decision goes through this function.
 */
export function isAdminIdentity(u: { email?: string | null; telegramUserId?: string | null }): boolean {
  const email = u.email?.trim().toLowerCase();
  if (email && env.adminEmails.includes(email)) return true;
  const tg = u.telegramUserId?.trim();
  return Boolean(tg && env.adminTelegramIds.includes(tg));
}

export function roleFor(u: { email?: string | null; telegramUserId?: string | null }): "admin" | "user" {
  return isAdminIdentity(u) ? "admin" : "user";
}

/** Re-derive the stored role from the allow-list (demotes stale admins, promotes newly listed ones). */
export async function syncRole<T extends AppUser>(u: T): Promise<T> {
  const role = roleFor(u);
  if (u.role === role) return u;
  await getDb().update(users).set({ role }).where(eq(users.id, u.id));
  log.info("Role re-derived from admin allow-list", { userId: u.id, role });
  return { ...u, role };
}

const httpError = (message: string, statusCode: number, code?: string) => Object.assign(new Error(message), { statusCode, code });

export async function userByPrivyId(privyUserId: string): Promise<AppUser | null> {
  return (await getDb().select().from(users).where(eq(users.privyUserId, privyUserId)).limit(1))[0] ?? null;
}

async function ownedWalletCount(userId: string): Promise<number> {
  return (await getDb().select({ id: wallets.id }).from(wallets).where(eq(wallets.userId, userId))).length;
}

/** Refresh profile fields and, when free, attach the Privy-linked Telegram id to an already-resolved user. */
const TOUCH_EVERY_MS = 5 * 60_000;

export async function touchPrivyUser(u: AppUser, profile: PrivyProfile): Promise<AppUser> {
  const db = getDb();
  // Hot path: nothing new to record → skip the UPDATE + re-SELECT round trips (lastSeenAt is refreshed every 5 min).
  const email = profile.email?.toLowerCase() ?? u.email;
  const fresh = Date.now() - Date.parse(u.lastSeenAt ?? "") < TOUCH_EVERY_MS;
  const tgNews = Boolean(
    profile.telegram?.id && (!u.telegramUserId || (profile.telegram.username && profile.telegram.username !== u.telegramUsername)),
  );
  if (fresh && email === u.email && (u.name || !profile.name) && !tgNews) return u;
  const patch: Partial<typeof users.$inferInsert> = {
    lastSeenAt: now(),
    email: profile.email?.toLowerCase() ?? u.email,
    name: u.name ?? profile.name ?? null,
  };
  const tg = profile.telegram;
  if (tg?.id) {
    if (!u.telegramUserId) {
      const holder = await userByTelegram(tg.id);
      if (!holder) {
        patch.telegramUserId = tg.id;
        patch.telegramUsername = tg.username ?? null;
      } else if (holder.id !== u.id) {
        // Never silently move a Telegram id between accounts.
        log.warn("Privy-linked Telegram already belongs to another SkyBOT user; not re-linking", { userId: u.id });
      }
    } else if (u.telegramUserId === tg.id && tg.username && tg.username !== u.telegramUsername) {
      patch.telegramUsername = tg.username;
    }
  }
  try {
    await db.update(users).set(patch).where(eq(users.id, u.id));
  } catch (e: any) {
    // Lost a race for the Telegram id: keep the profile refresh, drop the link.
    log.warn("user touch failed, retrying without Telegram link", { message: String(e?.message ?? e).slice(0, 120) });
    delete patch.telegramUserId;
    delete patch.telegramUsername;
    await db.update(users).set(patch).where(eq(users.id, u.id));
  }
  return (await db.select().from(users).where(eq(users.id, u.id)))[0]!;
}

/**
 * Resolve the SkyBOT account for a verified Privy user. One account per person, whatever the entry point:
 *  1. Known Privy id → that account.
 *  2. Privy user has a linked Telegram that already owns a SkyBOT account (Telegram-first / Mini App fallback)
 *     → attach this Privy id to it. If that account is already bound to a different real Privy user AND owns
 *     wallets, refuse with ACCOUNT_CONFLICT (wallets are owned by the other Privy user — never auto-merge).
 *  3. Otherwise create a new account. Insert is idempotent (ON CONFLICT DO NOTHING) so parallel first-login
 *     requests resolve to the same row instead of failing.
 */
export async function resolvePrivyUser(privyUserId: string, profile: PrivyProfile = {}, attempt = 0): Promise<AppUser> {
  const db = getDb();
  const existing = await userByPrivyId(privyUserId);
  if (existing) return touchPrivyUser(existing, profile);

  const tg = profile.telegram;
  if (tg?.id) {
    const tgUser = await userByTelegram(tg.id);
    if (tgUser) {
      const localOnly = tgUser.privyUserId.startsWith("tg:");
      if (!localOnly && (await ownedWalletCount(tgUser.id)) > 0) {
        log.warn("Account conflict: Telegram account is bound to a different Privy user that owns wallets", { userId: tgUser.id });
        throw httpError(
          "This Telegram account already belongs to a SkyBOT account that was created with a different login. Sign in with that original login (email or Google) and link Telegram from Settings, or contact the admin.",
          409,
          "ACCOUNT_CONFLICT",
        );
      }
      await db
        .update(users)
        .set({
          privyUserId,
          telegramUsername: tg.username ?? tgUser.telegramUsername,
          email: profile.email?.toLowerCase() ?? tgUser.email,
          name: tgUser.name ?? profile.name ?? null,
          lastSeenAt: now(),
        })
        .where(and(eq(users.id, tgUser.id), eq(users.privyUserId, tgUser.privyUserId)));
      const attached = await userByPrivyId(privyUserId);
      if (attached) {
        log.info("Attached Privy login to existing Telegram account", { userId: attached.id, from: localOnly ? "local" : "privy" });
        return attached;
      }
      // Concurrent request re-pointed the row first; retry resolution once.
      if (attempt < 2) return resolvePrivyUser(privyUserId, profile, attempt + 1);
      throw httpError("Could not resolve account, please retry", 409, "ACCOUNT_RACE");
    }
  }

  const email = profile.email?.toLowerCase() ?? null;
  const isAdmin = isAdminIdentity({ email, telegramUserId: tg?.id ?? null });
  const id = randomUUID();
  const t = now();
  await db
    .insert(users)
    .values({
      id,
      privyUserId,
      email,
      name: profile.name ?? null,
      role: isAdmin ? "admin" : "user",
      disabled: false,
      telegramUserId: tg?.id ?? null,
      telegramUsername: tg?.username ?? null,
      createdAt: t,
      lastSeenAt: t,
    })
    .onConflictDoNothing();
  const row = await userByPrivyId(privyUserId);
  if (!row) {
    // Insert skipped on a different unique key (e.g. Telegram id claimed concurrently) → resolve again.
    if (attempt < 2) return resolvePrivyUser(privyUserId, profile, attempt + 1);
    throw httpError("Could not create account, please retry", 409, "ACCOUNT_RACE");
  }
  await db.insert(settings).values({ userId: row.id }).onConflictDoNothing();
  if (row.id === id) log.info("New user", { role: row.role, hasEmail: Boolean(email), hasTelegram: Boolean(tg?.id) });
  return row;
}

/** @deprecated use resolvePrivyUser */
export const upsertUserFromPrivy = (privyUserId: string, profile: PrivyProfile) => resolvePrivyUser(privyUserId, profile);

/** Pull email / Google name / Telegram from a Privy user object (identity token or REST). */
export function profileFromPrivyUser(u: { linked_accounts?: any[] } | null | undefined): PrivyProfile {
  const accs = (u?.linked_accounts ?? []) as any[];
  const emailAcc = accs.find((a) => a?.type === "email");
  const google = accs.find((a) => a?.type === "google_oauth");
  const tg = accs.find((a) => a?.type === "telegram");
  // Only the numeric Telegram user id is comparable with initData user.id (never the opaque OIDC `sub`).
  const rawTgId = tg?.telegram_user_id ?? tg?.telegramUserId;
  const tgId = rawTgId !== undefined && /^\d+$/.test(String(rawTgId)) ? String(rawTgId) : null;
  return {
    email: emailAcc?.address ?? google?.email ?? null,
    name: google?.name ?? (tg ? [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username : null) ?? null,
    telegram: tgId ? { id: String(tgId), username: tg?.username ?? null } : null,
  };
}

export async function requireUser(userId: string): Promise<AppUser> {
  const u = (await getDb().select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw Object.assign(new Error("User not found"), { statusCode: 404 });
  if (u.disabled) throw Object.assign(new Error("Account disabled"), { statusCode: 403 });
  return u;
}

export function publicUser(u: AppUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: roleFor(u),
    telegramLinked: Boolean(u.telegramUserId),
    telegramUsername: u.telegramUsername,
    privyBacked: !u.privyUserId.startsWith("tg:"),
    createdAt: u.createdAt,
  };
}

/* ----------------------------- wallets (per user) ----------------------------- */

export function walletView(w: WalletRow) {
  return {
    id: w.id,
    label: w.label,
    address: w.address,
    group: w.groupName,
    source: w.source,
    isMain: w.isMain,
    privyWalletId: w.privyWalletId,
    hdIndex: w.hdIndex,
    createdAt: w.createdAt,
  };
}

export async function listWallets(userId: string) {
  return (await getDb().select().from(wallets).where(eq(wallets.userId, userId))).map(walletView);
}

export async function listGroups(userId: string, walletList?: { group: string | null }[]) {
  const db = getDb();
  const [gs, ws] = await Promise.all([
    db.select().from(groups).where(eq(groups.userId, userId)),
    walletList ? Promise.resolve(walletList) : listWallets(userId),
  ]);
  return gs.map((g) => ({ name: g.name, count: ws.filter((w) => w.group === g.name).length }));
}

/** Wallets + groups for one user with the two queries in parallel (Wallets page first paint). */
export async function walletsAndGroups(userId: string) {
  const db = getDb();
  const [ws, gs] = await Promise.all([listWallets(userId), db.select().from(groups).where(eq(groups.userId, userId))]);
  return { wallets: ws, groups: gs.map((g) => ({ name: g.name, count: ws.filter((w) => w.group === g.name).length })) };
}

export async function getWallet(userId: string, id: string): Promise<WalletRow> {
  const w = (
    await getDb()
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.id, id)))
      .limit(1)
  )[0];
  if (!w) throw Object.assign(new Error("Wallet not found"), { statusCode: 404 });
  return w;
}

export async function syncPrivyWallet(
  userId: string,
  input: { privyWalletId: string; address: string; label?: string; group?: string | null; source?: string; hdIndex?: number | null },
) {
  const db = getDb();
  const address = getAddress(input.address);
  const existing = (
    await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.address, address)))
      .limit(1)
  )[0];
  if (existing) {
    await db
      .update(wallets)
      .set({
        privyWalletId: input.privyWalletId,
        label: input.label ?? existing.label,
        groupName: input.group === undefined ? existing.groupName : input.group,
      })
      .where(eq(wallets.id, existing.id));
    return walletView((await db.select().from(wallets).where(eq(wallets.id, existing.id)))[0]!);
  }
  const id = randomUUID();
  const count = (await db.select().from(wallets).where(eq(wallets.userId, userId))).length;
  await db.insert(wallets).values({
    id,
    userId,
    privyWalletId: input.privyWalletId,
    address,
    label: input.label ?? `wallet-${count + 1}`,
    groupName: input.group ?? null,
    source: input.source ?? "privy",
    hdIndex: input.hdIndex ?? null,
    isMain: count === 0,
    createdAt: now(),
  });
  return walletView((await db.select().from(wallets).where(eq(wallets.id, id)))[0]!);
}

export async function generateWallets(user: AppUser, count: number, group: string | null = null, labelPrefix = "gen") {
  if (count < 1 || count > 50) throw Object.assign(new Error("count must be 1..50"), { statusCode: 400 });
  if (user.privyUserId.startsWith("tg:"))
    throw Object.assign(
      new Error(
        "This Telegram account isn't backed by a Privy user yet — Privy wallets can't be created. Ask the admin to check Privy setup.",
      ),
      { statusCode: 409, code: "NO_PRIVY_USER" },
    );
  const created = await createPrivyWallets(user.privyUserId, count);
  const out = [];
  for (let i = 0; i < created.length; i++) {
    out.push(
      await syncPrivyWallet(user.id, {
        privyWalletId: created[i].id,
        address: created[i].address,
        label: `${labelPrefix}-${i + 1}`,
        group,
        source: "generated",
      }),
    );
  }
  return out;
}

export async function importKey(_user: AppUser, _privateKey: string, _label = "", _group: string | null = null): Promise<never> {
  throw Object.assign(new Error("Private keys must be imported via Privy in the browser (importWallet). SkyBOT never accepts raw keys."), {
    statusCode: 403,
    code: "KEY_IMPORT_CLIENT_ONLY",
  });
}

export async function updateWallet(userId: string, id: string, patch: { label?: string; group?: string | null }) {
  await getWallet(userId, id);
  await getDb()
    .update(wallets)
    .set({
      ...(patch.label !== undefined ? { label: patch.label.slice(0, 64) } : {}),
      ...(patch.group !== undefined ? { groupName: patch.group } : {}),
    })
    .where(and(eq(wallets.userId, userId), eq(wallets.id, id)));
  return walletView(await getWallet(userId, id));
}

export async function removeWallet(userId: string, id: string) {
  await getWallet(userId, id);
  await getDb()
    .delete(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.id, id)));
}

export async function setMain(userId: string, id: string) {
  await getWallet(userId, id);
  const db = getDb();
  await db.update(wallets).set({ isMain: false }).where(eq(wallets.userId, userId));
  await db
    .update(wallets)
    .set({ isMain: true })
    .where(and(eq(wallets.userId, userId), eq(wallets.id, id)));
}

export async function createGroup(userId: string, name: string) {
  const n = name.trim().slice(0, 48);
  if (!n) throw Object.assign(new Error("group name required"), { statusCode: 400 });
  await getDb().insert(groups).values({ id: randomUUID(), userId, name: n, createdAt: now() }).onConflictDoNothing();
  return listGroups(userId);
}

export async function deleteGroup(userId: string, name: string) {
  const db = getDb();
  await db.delete(groups).where(and(eq(groups.userId, userId), eq(groups.name, name)));
  await db
    .update(wallets)
    .set({ groupName: null })
    .where(and(eq(wallets.userId, userId), eq(wallets.groupName, name)));
  return listGroups(userId);
}

/* ----------------------------- settings / telegram ----------------------------- */

export async function getSettings(userId: string) {
  const db = getDb();
  let s = (await db.select().from(settings).where(eq(settings.userId, userId)).limit(1))[0];
  if (!s) {
    await db.insert(settings).values({ userId: userId });
    s = (await db.select().from(settings).where(eq(settings.userId, userId)))[0]!;
  }
  return {
    priceCapEnabled: s.priceCapEnabled,
    dailyCapEnabled: s.dailyCapEnabled,
    openseaWalletLogin: s.openseaWalletLogin,
    caps: JSON.parse(s.capsJson || "{}") as Record<string, { maxPricePerNft?: string; maxDailySpend?: string }>,
  };
}

export async function updateSettings(
  userId: string,
  patch: Partial<{ priceCapEnabled: boolean; dailyCapEnabled: boolean; openseaWalletLogin: boolean; caps: Record<string, any> }>,
) {
  await getSettings(userId);
  const cur = await getSettings(userId);
  await getDb()
    .update(settings)
    .set({
      priceCapEnabled: patch.priceCapEnabled ?? cur.priceCapEnabled,
      dailyCapEnabled: patch.dailyCapEnabled ?? cur.dailyCapEnabled,
      openseaWalletLogin: patch.openseaWalletLogin ?? cur.openseaWalletLogin,
      capsJson: JSON.stringify(patch.caps ?? cur.caps),
    })
    .where(eq(settings.userId, userId));
  return getSettings(userId);
}

export async function createTelegramLinkCode(userId: string) {
  const code = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await getDb().insert(telegramLinks).values({ code, userId, expiresAt, metaJson: "{}" });
  const bot = env.telegramBotUsername;
  return { code, expiresAt, deepLink: bot ? `https://t.me/${bot}?start=link_${code}` : null };
}

export async function consumeTelegramLink(code: string, telegramUserId: string, telegramUsername: string | null) {
  const db = getDb();
  const row = (await db.select().from(telegramLinks).where(eq(telegramLinks.code, code)).limit(1))[0];
  if (!row) throw Object.assign(new Error("Invalid or expired link code"), { statusCode: 400 });
  if (row.userId.startsWith("pending:"))
    throw Object.assign(new Error("This code is for the web Settings paste — open Settings → Claim"), { statusCode: 400 });
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(telegramLinks).where(eq(telegramLinks.code, code));
    throw Object.assign(new Error("Link code expired — generate a new one in Settings"), { statusCode: 400 });
  }
  const taken = (await db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1))[0];
  if (taken && taken.id !== row.userId)
    throw Object.assign(new Error("This Telegram account is already linked to another SkyBOT user"), { statusCode: 409 });
  await db.update(users).set({ telegramUserId, telegramUsername }).where(eq(users.id, row.userId));
  await db.delete(telegramLinks).where(eq(telegramLinks.code, code));
  return requireUser(row.userId);
}

/** Telegram → web: one-time code the user pastes in Settings. */
export async function createReverseTelegramCode(telegramUserId: string, telegramUsername: string | null) {
  const code = randomBytes(8).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await getDb()
    .insert(telegramLinks)
    .values({
      code,
      userId: `pending:${telegramUserId}`,
      expiresAt,
      metaJson: JSON.stringify({ telegramUsername }),
    });
  return { code, expiresAt, username: telegramUsername };
}

export async function claimReverseTelegramCode(userId: string, code: string) {
  const db = getDb();
  const row = (await db.select().from(telegramLinks).where(eq(telegramLinks.code, code)).limit(1))[0];
  if (!row) throw Object.assign(new Error("Invalid or expired code"), { statusCode: 400 });
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(telegramLinks).where(eq(telegramLinks.code, code));
    throw Object.assign(new Error("Code expired"), { statusCode: 400 });
  }
  if (!row.userId.startsWith("pending:")) {
    throw Object.assign(new Error("This code was generated on the web — open the Telegram deep link instead"), { statusCode: 400 });
  }
  const tgId = row.userId.slice("pending:".length);
  let username: string | null = null;
  try {
    username = JSON.parse(row.metaJson || "{}").telegramUsername ?? null;
  } catch {
    /* */
  }
  const taken = await userByTelegram(tgId);
  if (taken && taken.id !== userId)
    throw Object.assign(new Error("That Telegram account is already linked to another user"), { statusCode: 409 });
  await db.update(users).set({ telegramUserId: tgId, telegramUsername: username }).where(eq(users.id, userId));
  await db.delete(telegramLinks).where(eq(telegramLinks.code, code));
  return { ok: true as const, telegramUserId: tgId, telegramUsername: username };
}

export async function unlinkTelegram(userId: string) {
  await getDb().update(users).set({ telegramUserId: null, telegramUsername: null }).where(eq(users.id, userId));
}

export async function userByTelegram(telegramUserId: string) {
  return (await getDb().select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1))[0] ?? null;
}

/* ----------------------------- admin / rate limit ----------------------------- */

export async function listUsersAdmin() {
  const db = getDb();
  const all = await db.select().from(users).orderBy(desc(users.createdAt));
  const out = [];
  for (const u of all) {
    const wc =
      (
        await db
          .select({ c: sql<number>`count(*)` })
          .from(wallets)
          .where(eq(wallets.userId, u.id))
      )[0]?.c ?? 0;
    const jc =
      (
        await db
          .select({ c: sql<number>`count(*)` })
          .from(jobs)
          .where(eq(jobs.userId, u.id))
      )[0]?.c ?? 0;
    out.push({ ...publicUser(u), disabled: u.disabled, walletCount: Number(wc), jobCount: Number(jc), lastSeenAt: u.lastSeenAt });
  }
  return out;
}

export async function setUserDisabled(adminId: string, targetId: string, disabled: boolean) {
  if (adminId === targetId) throw Object.assign(new Error("Cannot disable yourself"), { statusCode: 400 });
  await getDb().update(users).set({ disabled }).where(eq(users.id, targetId));
}

export async function checkRateLimit(userId: string, route: string, limit = env.rateLimitPerMinute) {
  const { rateLimit } = await import("../util/ratelimit.js");
  await rateLimit(`${userId}:${route}`, limit);
}

/* ----------------------------- Telegram-first accounts ----------------------------- */

/** Find or create the Privy user that owns this Telegram id (imported linked account), so Privy wallets work. */
async function privyUserForTelegram(tg: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<string | null> {
  if (!privyConfigured()) return null;
  const privy = getPrivy() as any;
  try {
    const u = await privy.users().getByTelegramUserID({ telegram_user_id: String(tg.id) });
    if (u?.id) return u.id as string;
  } catch {
    /* not found */
  }
  try {
    const u = await privy.users().create({
      linked_accounts: [
        { type: "telegram", telegram_user_id: String(tg.id), username: tg.username, first_name: tg.first_name, last_name: tg.last_name },
      ],
    });
    return u.id as string;
  } catch (e: any) {
    log.warn("Privy user create for Telegram failed — using local tg: id", { message: String(e?.message ?? e).slice(0, 200) });
    return null;
  }
}

/** Telegram-first login: returns the linked SkyBOT user, creating one (BasedBot style) if needed. */
export async function upsertTelegramFirstUser(tg: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<{ user: AppUser; created: boolean }> {
  const tgId = String(tg.id);
  const existing = await userByTelegram(tgId);
  if (existing) {
    if (tg.username && tg.username !== existing.telegramUsername)
      await getDb().update(users).set({ telegramUsername: tg.username, lastSeenAt: now() }).where(eq(users.id, existing.id));
    return { user: existing, created: false };
  }
  const db = getDb();
  const privyId = (await privyUserForTelegram(tg)) ?? `tg:${tgId}`;
  // A SkyBOT user may already exist for this Privy id (e.g. Privy Telegram login used before) — attach.
  const byPrivy = (await db.select().from(users).where(eq(users.privyUserId, privyId)).limit(1))[0];
  if (byPrivy) {
    await db
      .update(users)
      .set({ telegramUserId: tgId, telegramUsername: tg.username ?? null, lastSeenAt: now() })
      .where(eq(users.id, byPrivy.id));
    return { user: await requireUser(byPrivy.id), created: false };
  }
  const isAdmin = isAdminIdentity({ telegramUserId: tgId });
  const id = randomUUID();
  const t = now();
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || null;
  await db
    .insert(users)
    .values({
      id,
      privyUserId: privyId,
      email: null,
      name,
      role: isAdmin ? "admin" : "user",
      disabled: false,
      telegramUserId: tgId,
      telegramUsername: tg.username ?? null,
      createdAt: t,
      lastSeenAt: t,
    })
    .onConflictDoNothing();
  // Parallel first opens of the Mini App: whoever inserted first wins, everyone resolves to that row.
  const row = (await userByTelegram(tgId)) ?? (await userByPrivyId(privyId));
  if (!row) throw httpError("Could not create account, please retry", 409, "ACCOUNT_RACE");
  await db.insert(settings).values({ userId: row.id }).onConflictDoNothing();
  if (row.id !== id) return { user: await requireUser(row.id), created: false };
  log.info("New Telegram-first user", { role: isAdmin ? "admin" : "user", privyBacked: !privyId.startsWith("tg:") });
  return { user: await requireUser(id), created: true };
}

/**
 * Attach a Privy (email/Google) login to a Telegram-first SkyBOT user. Caller must prove BOTH:
 * a valid SkyBOT session cookie (Telegram-verified) AND a valid Privy access token.
 */
export async function attachPrivyToUser(userId: string, privyUserId: string, profile: PrivyProfile) {
  const db = getDb();
  const me = await requireUser(userId);
  if (me.privyUserId === privyUserId) return touchPrivyUser(me, profile);
  const other = await userByPrivyId(privyUserId);
  if (other && other.id !== userId) {
    log.warn("attach-privy conflict: Privy login already owns another SkyBOT account", { userId });
    throw httpError(
      "That login already has its own SkyBOT account. Sign in with Telegram through Privy, then link email or Google from Settings so Privy keeps them together.",
      409,
      "ACCOUNT_CONFLICT",
    );
  }
  // A real Privy user already owns this account's wallets: re-pointing would orphan them.
  if (!me.privyUserId.startsWith("tg:") && (await ownedWalletCount(userId)) > 0) {
    log.warn("attach-privy refused: account wallets belong to its current Privy user", { userId });
    throw httpError(
      "This account's wallets belong to its Telegram login. Use Connect with Privy (Telegram) first, then link email or Google from Settings.",
      409,
      "ACCOUNT_CONFLICT",
    );
  }
  await db
    .update(users)
    .set({ privyUserId, email: profile.email?.toLowerCase() ?? me.email, name: me.name ?? profile.name ?? null })
    .where(eq(users.id, userId));
  return touchPrivyUser(await requireUser(userId), profile);
}
