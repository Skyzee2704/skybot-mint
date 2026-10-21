// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-in-only signer (Telegram /check): keeps the OpenSea SIWE key quorum attached to every embedded wallet.
 *
 * Privy custody rules (docs.privy.io › Authorization keys › Self-custodial user wallets):
 *  - wallets created by Privy's client SDKs (and imports) are owned by the USER (a user key quorum); changing
 *    their signers needs the owner's authorization;
 *  - the server-side route for that (`authorization_context.user_jwts` → POST /v1/wallets/authenticate) rejects
 *    this app's Privy access tokens with 400 "Invalid JWT token provided" — reproduced with a freshly issued,
 *    locally verified token (encrypted and raw requests alike), so it is not used;
 *  - the member's own browser session can add it (`useSigners().addSigners`): the server reports which wallets
 *    still miss the signer, the app adds exactly those, then asks the server to re-verify;
 *  - with the member offline only a wallet owned by a key quorum that includes our app key can be updated.
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
 * Make sure the sign-in-only quorum is an additional signer on one wallet. Only app-owned wallets (owner = our app
 * key quorum) can be updated from here; user-owned wallets report "needs_owner" so the member's app adds it.
 */
export async function ensureSignerOnWallet(privyWalletId: string): Promise<SignerOutcome> {
  if (!privySiweSignerReady()) return "skipped";
  const { getPrivy } = await import("../auth/privy.js");
  const privy = getPrivy();
  const quorum = env.privySiweKeyQuorumId!;
  const policy = env.privySiwePolicyId!;
  const w: any = await privy.wallets().get(privyWalletId);
  const current: any[] = w?.additional_signers ?? [];
  if (current.some((s) => s?.signer_id === quorum)) return "already";
  if (!(env.privyAuthPrivateKey && env.privyAuthKeyQuorumId && w?.owner_id === env.privyAuthKeyQuorumId)) return "needs_owner";
  // Signer updates replace the list: keep every existing signer exactly as it is.
  const next = [
    ...current.map((s) => ({
      signer_id: s.signer_id,
      ...(s.override_policy_ids?.length ? { override_policy_ids: s.override_policy_ids } : {}),
    })),
    { signer_id: quorum, override_policy_ids: [policy] },
  ];
  await privy.wallets().update(privyWalletId, {
    additional_signers: next,
    authorization_context: { authorization_private_keys: [env.privyAuthPrivateKey] },
  } as any);
  return "attached";
}

export type SignerReport = Record<SignerOutcome, number> & {
  /** Addresses (checksummed) already carrying the signer — the app skips these. */
  attachedAddresses: string[];
  /** Addresses still without it — the app adds the signer with the member's own session. */
  missingAddresses: string[];
};

/**
 * Verify the signer on a user's wallets (fixing legacy wallet ids). Already-attached wallets are never re-read.
 * `force` re-checks every unattached wallet now (signed-in visits); otherwise each at most every 6 h (housekeeping).
 */
export async function ensureSiweSigners(
  user: { id: string; privyUserId: string | null },
  opts: { force?: boolean } = {},
): Promise<SignerReport> {
  const out: SignerReport = {
    attached: 0,
    already: 0,
    needs_owner: 0,
    no_privy_wallet: 0,
    error: 0,
    skipped: 0,
    attachedAddresses: [],
    missingAddresses: [],
  };
  if (!privySiweSignerReady() || !user.privyUserId || user.privyUserId.startsWith("tg:")) return out;
  const db = getDb();
  const ws = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, user.id), isNull(wallets.removedAt)));
  if (!ws.length) return out;
  const status = new Map((await db.select().from(siweSigners)).map((s) => [s.walletId, s]));
  const todo: typeof ws = [];
  for (const w of ws) {
    const s = status.get(w.id);
    if (s?.attachedAt) {
      out.already++;
      out.attachedAddresses.push(w.address);
    } else if (opts.force || !s || Date.now() - Date.parse(s.checkedAt) > RECHECK_MS) todo.push(w);
    else out.missingAddresses.push(w.address);
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
      const r = await ensureSignerOnWallet(id);
      out[r]++;
      const ok = r === "attached" || r === "already";
      (ok ? out.attachedAddresses : out.missingAddresses).push(w.address);
      await mark(w.id, ok, r === "needs_owner" ? "added by the member's app" : null);
    } catch (e: any) {
      out.error++;
      out.missingAddresses.push(w.address);
      const msg = redactString(String(e?.message ?? e)).slice(0, 160);
      log.warn("siwe signer check failed", msg);
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
    n++;
    for (const k of Object.keys(total) as SignerOutcome[]) total[k] += r[k];
  }
  return total;
}
