// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-in-only signer (Telegram /check): keeps the OpenSea SIWE key quorum attached to every embedded wallet.
 *
 * Privy custody rules (docs.privy.io › Authorization keys › Self-custodial user wallets):
 *  - wallets created by Privy's client SDKs (and imports) are owned by the USER; changing their signers needs the
 *    owner's authorization signature;
 *  - from the server, that signature comes from the user's Privy access token (`authorization_context.user_jwts`,
 *    the SDK exchanges it for a short-lived user key) — so any signed-in web / Mini App request can attach it;
 *  - with no user token (user offline) only a wallet owned by a key quorum that includes our app key can be updated.
 * The signer itself can only personal_sign OpenSea's login text (Privy policy + our SIWE guard), never transact.
 */
import { and, eq, isNull } from "drizzle-orm";
import { env, privyConfigured, privySiweSignerReady } from "../config/env.js";
import { getDb } from "../db/client.js";
import { siweSigners, users, wallets } from "../db/schema.js";
import { log, redactString } from "../util/log.js";

export const looksLikePrivyWalletId = (s: string | null | undefined): s is string =>
  Boolean(s && !/^0x/i.test(s) && /^[a-z0-9]{16,40}$/i.test(s));

type WalletLite = { id: string; userId: string; address: string; privyWalletId: string | null };

const RECHECK_MS = 6 * 3600_000;
const iso = () => new Date().toISOString();

/** Address (lower-case) → Privy wallet id for every embedded EVM wallet of a Privy user. */
export async function privyWalletIds(privyUserId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!privyConfigured() || !privyUserId || privyUserId.startsWith("tg:")) return out;
  const { getPrivy } = await import("../auth/privy.js");
  const pu: any = await getPrivy().users()._get(privyUserId);
  for (const a of pu?.linked_accounts ?? []) {
    if (a?.type === "wallet" && a?.wallet_client_type === "privy" && (a?.chain_type ?? "ethereum") === "ethereum" && a?.id && a?.address)
      out.set(String(a.address).toLowerCase(), String(a.id));
  }
  return out;
}

/** The real Privy wallet id for a SkyBOT wallet (older rows stored the address); fixes the row when it can. */
export async function resolvePrivyWalletId(w: WalletLite, privyUserId?: string | null): Promise<string | null> {
  if (looksLikePrivyWalletId(w.privyWalletId)) return w.privyWalletId;
  try {
    let pid = privyUserId;
    if (pid === undefined) pid = (await getDb().select().from(users).where(eq(users.id, w.userId)).limit(1))[0]?.privyUserId ?? null;
    if (!pid) return null;
    const id = (await privyWalletIds(pid)).get(w.address.toLowerCase()) ?? null;
    if (id) await getDb().update(wallets).set({ privyWalletId: id }).where(eq(wallets.id, w.id));
    return id;
  } catch (e: any) {
    log.warn("privy wallet id lookup failed", redactString(String(e?.message ?? e)).slice(0, 160));
    return null;
  }
}

async function mark(walletId: string, attached: boolean, note: string | null) {
  const at = iso();
  const v = { walletId, attachedAt: attached ? at : null, checkedAt: at, note };
  await getDb()
    .insert(siweSigners)
    .values(v)
    .onConflictDoUpdate({ target: siweSigners.walletId, set: { attachedAt: v.attachedAt, checkedAt: at, note } });
}

export type SignerOutcome = "attached" | "already" | "needs_owner" | "no_privy_wallet" | "error" | "skipped";

/**
 * Make sure the sign-in-only quorum is an additional signer on one wallet.
 * `userJwt` = the member's Privy access token (owner authorization). Without it only app-owned wallets can be updated.
 */
export async function ensureSignerOnWallet(privyWalletId: string, userJwt?: string | null): Promise<SignerOutcome> {
  if (!privySiweSignerReady()) return "skipped";
  const { getPrivy } = await import("../auth/privy.js");
  const privy = getPrivy();
  const quorum = env.privySiweKeyQuorumId!;
  const policy = env.privySiwePolicyId!;
  const w: any = await privy.wallets().get(privyWalletId);
  const current: any[] = w?.additional_signers ?? [];
  if (current.some((s) => s?.signer_id === quorum)) return "already";
  let ctx: { user_jwts?: string[]; authorization_private_keys?: string[] } | null = null;
  if (userJwt) ctx = { user_jwts: [userJwt] };
  else if (env.privyAuthPrivateKey && env.privyAuthKeyQuorumId && w?.owner_id === env.privyAuthKeyQuorumId)
    ctx = { authorization_private_keys: [env.privyAuthPrivateKey] };
  if (!ctx) return "needs_owner";
  // Signer updates replace the list: keep every existing signer exactly as it is.
  const next = [
    ...current.map((s) => ({
      signer_id: s.signer_id,
      ...(s.override_policy_ids?.length ? { override_policy_ids: s.override_policy_ids } : {}),
    })),
    { signer_id: quorum, override_policy_ids: [policy] },
  ];
  await privy.wallets().update(privyWalletId, { additional_signers: next, authorization_context: ctx } as any);
  return "attached";
}

/**
 * Attach / verify the signer on a user's wallets. With `userJwt` (signed-in request) every missing signer is added;
 * without it (housekeeping) wallets are only checked, at most every 6 h each.
 */
export async function ensureSiweSigners(
  user: { id: string; privyUserId: string | null },
  opts: { userJwt?: string | null; force?: boolean } = {},
): Promise<Record<SignerOutcome, number>> {
  const out: Record<SignerOutcome, number> = { attached: 0, already: 0, needs_owner: 0, no_privy_wallet: 0, error: 0, skipped: 0 };
  if (!privySiweSignerReady() || !user.privyUserId || user.privyUserId.startsWith("tg:")) return out;
  const db = getDb();
  const ws = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, user.id), isNull(wallets.removedAt)));
  if (!ws.length) return out;
  const status = new Map((await db.select().from(siweSigners)).map((s) => [s.walletId, s]));
  const todo = ws.filter((w) => {
    const s = status.get(w.id);
    if (s?.attachedAt) return false;
    if (opts.userJwt || opts.force || !s) return true;
    return Date.now() - Date.parse(s.checkedAt) > RECHECK_MS;
  });
  if (!todo.length) {
    out.already = ws.length;
    return out;
  }
  let ids: Map<string, string> | null = null;
  // Sequential on purpose: Privy rewrites a wallet's signer list per update.
  for (const w of todo) {
    try {
      let id = looksLikePrivyWalletId(w.privyWalletId) ? w.privyWalletId : null;
      if (!id) {
        ids ??= await privyWalletIds(user.privyUserId);
        id = ids.get(w.address.toLowerCase()) ?? null;
        if (id) await db.update(wallets).set({ privyWalletId: id }).where(eq(wallets.id, w.id));
      }
      if (!id) {
        out.no_privy_wallet++;
        await mark(w.id, false, "not a Privy embedded wallet");
        continue;
      }
      const r = await ensureSignerOnWallet(id, opts.userJwt);
      out[r]++;
      await mark(w.id, r === "attached" || r === "already", r === "needs_owner" ? "owner authorization needed" : null);
    } catch (e: any) {
      out.error++;
      const msg = redactString(String(e?.message ?? e)).slice(0, 160);
      log.warn("siwe signer attach failed", msg);
      await mark(w.id, false, msg.slice(0, 120)).catch(() => {});
    }
  }
  return out;
}

/** Housekeeping / one-off backfill across all members (no user tokens: verifies + fixes wallet ids, attaches where allowed). */
export async function backfillSiweSigners(opts: { force?: boolean; maxUsers?: number } = {}) {
  const total: Record<SignerOutcome, number> = { attached: 0, already: 0, needs_owner: 0, no_privy_wallet: 0, error: 0, skipped: 0 };
  if (!privySiweSignerReady()) return total;
  const us = await getDb().select().from(users);
  let n = 0;
  for (const u of us) {
    if (opts.maxUsers && n >= opts.maxUsers) break;
    if (!u.privyUserId || u.privyUserId.startsWith("tg:")) continue;
    const r = await ensureSiweSigners(u, { force: opts.force });
    if (Object.values(r).some(Boolean)) n++;
    for (const k of Object.keys(total) as SignerOutcome[]) total[k] += r[k];
  }
  return total;
}
