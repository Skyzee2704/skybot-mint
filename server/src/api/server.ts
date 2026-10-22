// SPDX-License-Identifier: AGPL-3.0-only
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { formatEther } from "ethers";
import { CHAINS, requireChain, rpcsForChain } from "../config/chains.js";
import { configStatus, env, privyConfigured, privyServerSigningReady, privySiweSignerReady } from "../config/env.js";
import { requireAuth, adminGate } from "../auth/middleware.js";
import { getPool } from "../core/rpc/pool.js";
import { getResolved, refresh, resolveCached } from "../core/resolver/cache.js";
import { checkEligibility } from "../core/mint/eligibility.js";
import { balancesAsOf, cachedBalances } from "../util/balanceCache.js";
import { nativeBalancesBatch } from "../core/rpc/multicall.js";
import { registerWithdrawRoutes } from "./withdrawRoutes.js";
import { registerNftRoutes } from "./nftRoutes.js";
import { simulateMint } from "../core/mint/simulate.js";
import { consumePlan } from "../core/plans.js";
import { cancelJob, enqueueMint } from "../jobs/scheduler.js";
import { listJobs, getJob, listMinted } from "../core/jobs/repo.js";
import {
  publicUser,
  listWallets,
  walletsOverview,
  generateWallets,
  syncPrivyWallet,
  updateWallet,
  setMain,
  getSettings,
  updateSettings,
  createTelegramLinkCode,
  claimReverseTelegramCode,
  unlinkTelegram,
  listUsersAdmin,
  setUserDisabled,
} from "../users/service.js";
import { defaultCapValues, dailySpent } from "../core/safety/safety.js";
import { MintRequest } from "../core/mint/types.js";
import { redactString, log } from "../util/log.js";
import { dbMode, ensureDb } from "../db/client.js";
import { signSession, verifySession, readCookie, sessionCookie, clearSessionCookie } from "../auth/session.js";
import { verifyPrivyAccessToken, getPrivy } from "../auth/privy.js";
import { upsertTelegramFirstUser, attachPrivyToUser, checkRateLimit, profileFromPrivyUser } from "../users/service.js";
import { validateInitData, publicHttpsReady } from "../bot/telegramWebApp.js";
import { handleWebhookUpdate, setupTelegramWebhook } from "../bot/telegram.js";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const strategy = z.enum(["seadrop_public", "opensea_api", "generic"]);
const mintReq = z.object({
  chain: z.string(),
  contract: addr,
  input: z.string().optional(),
  strategy,
  slug: z.string().nullable().optional(),
  wallets: z
    .array(z.object({ walletId: z.string(), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(500),
  generic: z
    .object({ signature: z.string(), priceWei: z.string().regex(/^\d+$/), tokenId: z.string().regex(/^\d+$/).optional() })
    .optional(),
  gasMode: z.enum(["eco", "normal", "aggressive"]).optional(),
  gasLimit: z.number().int().min(21000).max(5_000_000).optional(),
  runAt: z.string().datetime().nullable().optional(),
  offsetMs: z.number().int().min(-5000).max(60000).optional(),
  forceWalletIds: z.array(z.string().max(100)).max(500).optional(),
  stage: z.string().max(200).nullable().optional(),
});

/**
 * Best effort, time-boxed check of the sign-in-only signer on a member's wallets (never fails the request).
 * Returns which addresses already carry it, so the app adds it only where it's missing.
 */
async function siweSignerStatus(user: { id: string; privyUserId: string | null }) {
  if (!privySiweSignerReady()) return null;
  const { ensureSiweSigners } = await import("../users/siweSigner.js");
  return (await Promise.race([
    ensureSiweSigners(user, { force: true }).catch((e) => {
      log.warn("siwe signer check", redactString(String(e?.message ?? e)).slice(0, 160));
      return null;
    }),
    new Promise((r) => setTimeout(() => r(null), 5_000)),
  ])) as Awaited<ReturnType<typeof ensureSiweSigners>> | null;
}

/** Wallet added / removed / restored: update the Alchemy webhook address lists (time-boxed, best effort). */
async function walletSetChanged() {
  try {
    const { syncAfterWalletChange } = await import("../core/alchemy/sync.js");
    await syncAfterWalletChange();
  } catch (e: any) {
    log.warn("alchemy sync after wallet change", String(e?.message ?? e).slice(0, 160));
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(helmet, {
    contentSecurityPolicy: false, // API only; CSP is on the Next.js web app
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = env.corsOrigins.some((o) => origin === o || origin.startsWith(o));
      cb(null, ok);
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type", "Privy-Id-Token", "X-Telegram-Init-Data", "X-SkyBOT-CSRF"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Serverless: make sure the DB is connected + migrated before any route runs (guarded, once per instance).
  app.addHook("onRequest", async () => {
    await ensureDb();
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err.statusCode ?? (err instanceof z.ZodError ? 400 : 500);
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : redactString(String(err.message ?? err));
    if (status >= 500) log.error("API error", err);
    reply.code(status).send({ error: message, code: err.code });
  });

  /* ---------- public ---------- */
  app.get("/api/health", async () => ({
    ok: true,
    brand: "SkyBOT Mint",
    db: dbMode(),
    miniApp: publicHttpsReady(),
    webhook: Boolean(env.telegramWebhookSecret),
    scheduler: env.qstashToken ? "qstash" : "local",
  }));

  /**
   * Mini App login (fallback when Privy Telegram seamless auth is off): verify initData HMAC (max 1h old),
   * find or create the Telegram-first SkyBOT user, and set a 1h httpOnly session cookie.
   */
  app.post("/api/telegram/session", async (req, reply) => {
    const { initData } = z.object({ initData: z.string().min(10).max(4096) }).parse(req.body);
    const v = validateInitData(initData, 3600);
    const { user, created } = await upsertTelegramFirstUser(v.user);
    if (user.disabled) return reply.code(403).send({ error: "Account disabled" });
    await checkRateLimit(user.id, "/api/telegram/session", 20);
    const { token, exp } = signSession(user.id);
    reply.header("set-cookie", sessionCookie(token));
    reply.header("cache-control", "no-store");
    return { ok: true, created, expiresAt: new Date(exp * 1000).toISOString(), user: publicUser(user) };
  });
  app.post("/api/session/logout", async (_req, reply) => {
    reply.header("set-cookie", clearSessionCookie());
    return { ok: true };
  });

  /** Attach email/Google (Privy) to a Telegram-first account. Needs BOTH the session cookie and a Privy token. */
  app.post("/api/account/attach-privy", async (req, reply) => {
    if (req.headers["x-skybot-csrf"] !== "1") return reply.code(403).send({ error: "CSRF header missing" });
    const sid = verifySession(readCookie(req.headers.cookie));
    const tok = (req.headers.authorization ?? "").startsWith("Bearer ") ? req.headers.authorization!.slice(7) : null;
    if (!sid || !tok) return reply.code(401).send({ error: "Need Telegram session and Privy login" });
    const claims = await verifyPrivyAccessToken(tok).catch(() => null);
    if (!claims) return reply.code(401).send({ error: "Invalid Privy token" });
    let profile: ReturnType<typeof profileFromPrivyUser> = {};
    const idToken = req.headers["privy-id-token"] as string | undefined;
    if (idToken) {
      try {
        const u = await getPrivy().utils().auth().verifyIdentityToken(idToken);
        if ((u as any)?.id === claims.privyUserId) profile = profileFromPrivyUser(u as any);
      } catch {
        /* optional */
      }
    }
    return { user: publicUser(await attachPrivyToUser(sid, claims.privyUserId, profile)) };
  });

  /** Telegram webhook (Vercel). Secret header ALWAYS required; 404 when webhook mode isn't configured. */
  app.post("/api/telegram/webhook", async (req, reply) => {
    const secret = env.telegramWebhookSecret;
    if (!secret || !env.telegramBotToken) return reply.code(404).send({ error: "not found" });
    const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    const { timingSafeEqual } = await import("node:crypto");
    const a = Buffer.from(got),
      b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "bad secret" });
    try {
      await handleWebhookUpdate(req.body);
    } catch (e: any) {
      log.error("webhook update failed", redactString(String(e?.message ?? e)));
    }
    return { ok: true }; // always 200 to Telegram so a bad update isn't retried forever
  });
  app.get("/api/status", async () => ({
    brand: "SkyBOT Mint",
    privyConfigured: privyConfigured(),
    privyAppId: env.privyAppId ?? null,
    serverSigning: privyServerSigningReady(),
    config: configStatus(),
    setup: !privyConfigured()
      ? {
          title: "Privy setup required",
          steps: [
            "Create an app at https://dashboard.privy.io (or use the existing SkyBOT Mint app)",
            "Set PRIVY_APP_ID and PRIVY_APP_SECRET in the environment",
            "Enable Email, Google and Telegram login methods (Telegram: OAuth Client ID + secret from @BotFather, plus bot token and name for Mini App seamless login)",
            "Add your domain(s) under Allowed origins (include http://localhost:3000 for local)",
            "Embedded wallets: create on login = all users (or create on demand)",
            "For scheduled mints: create an authorization key, register a key quorum, set PRIVY_AUTH_PRIVATE_KEY + PRIVY_AUTH_KEY_QUORUM_ID, and add the quorum as a session signer on user wallets",
          ],
        }
      : null,
    chains: CHAINS.map((c) => {
      const r = rpcsForChain(c);
      return {
        key: c.key,
        chainId: c.chainId,
        name: c.name,
        nativeSymbol: c.nativeSymbol,
        seadrop: c.seadrop,
        privateRpc: r.hasPrivate,
        rpcCount: r.read.length,
        sendRpcCount: r.send.length,
      };
    }),
  }));

  /* ---------- authenticated ---------- */
  app.register(async (a) => {
    a.addHook("onRequest", requireAuth);

    a.put("/api/me/timezone", async (req) => {
      const { timeZone } = z.object({ timeZone: z.string().min(1).max(64) }).parse(req.body);
      const { setUserTimeZone } = await import("../users/service.js");
      return { timeZone: await setUserTimeZone(req.user!, timeZone) };
    });
    a.get("/api/me", async (req) => {
      // Which wallets still miss the sign-in-only signer (Telegram /check). The app adds it with the member's own
      // Privy session; the server can't (Privy rejects user JWTs at /v1/wallets/authenticate for this app).
      const st = req.privyAccessToken ? await siweSignerStatus(req.user!) : null;
      return {
        user: publicUser(req.user!),
        authVia: req.authVia,
        serverSigning: privyServerSigningReady(),
        // Public ids only (no keys).
        siweSigner: privySiweSignerReady()
          ? {
              signerId: env.privySiweKeyQuorumId,
              policyId: env.privySiwePolicyId,
              attached: st?.attachedAddresses ?? null,
              missing: st?.missingAddresses ?? null,
            }
          : null,
      };
    });
    // After the app added the signer: re-verify against Privy and record it (so /check can sign server-side).
    a.post("/api/wallets/siwe-signer/verify", async (req) => {
      const st = await siweSignerStatus(req.user!);
      if (st) log.info("siwe signer verify", { attached: st.attachedAddresses.length, missing: st.missingAddresses.length });
      return { attached: st?.attachedAddresses ?? [], missing: st?.missingAddresses ?? [] };
    });

    a.get("/api/chains/health", async () =>
      Promise.all(
        CHAINS.map(async (c) => {
          const pool = getPool(c);
          let ok = false;
          let error: string | null = null;
          let block: number | null = null;
          try {
            await pool.checkChainId();
            block = await pool.read((p) => p.getBlockNumber(), "blockNumber");
            ok = true;
          } catch (e: any) {
            error = redactString(e.message);
          }
          return {
            key: c.key,
            chainId: c.chainId,
            ok,
            block,
            error,
            endpoints: pool.status().map((s) => ({ ...s, lastError: s.lastError ? redactString(s.lastError) : null })),
          };
        }),
      ),
    );

    // Settings
    a.get("/api/settings", async (req) => {
      const st = await getSettings(req.user!.id);
      return {
        ...st,
        chains: await Promise.all(
          CHAINS.map(async (c) => {
            const def = defaultCapValues(c);
            const v = st.caps[c.key] ?? {};
            return {
              key: c.key,
              name: c.name,
              nativeSymbol: c.nativeSymbol,
              maxPricePerNft: v.maxPricePerNft ?? def.maxPricePerNft,
              maxDailySpend: v.maxDailySpend ?? def.maxDailySpend,
              dailySpent: formatEther(await dailySpent(req.user!.id, c)),
            };
          }),
        ),
        alwaysOn: [
          "chain-ID check",
          "mint target must be SeaDrop / resolved contract",
          "approve / transfer-style calls blocked",
          "OpenSea tx value ≤ stage price × qty",
          "MAX_GAS_PRICE_GWEI",
        ],
        telegram: {
          linked: Boolean(req.user!.telegramUserId),
          username: req.user!.telegramUsername,
          botUsername: env.telegramBotUsername ?? null,
        },
      };
    });
    a.put("/api/settings", async (req) => {
      const num = z.string().regex(/^\d+(\.\d+)?$/);
      const b = z
        .object({
          priceCapEnabled: z.boolean().optional(),
          dailyCapEnabled: z.boolean().optional(),
          openseaWalletLogin: z.boolean().optional(),
          caps: z.record(z.string(), z.object({ maxPricePerNft: num.optional(), maxDailySpend: num.optional() })).optional(),
        })
        .parse(req.body);
      for (const k of Object.keys(b.caps ?? {})) requireChain(k);
      return updateSettings(req.user!.id, b);
    });

    // Legacy link-code endpoints (superseded by Privy account linking; kept for backward compatibility, not used by the UI)
    a.post("/api/telegram/link-code", async (req) => createTelegramLinkCode(req.user!.id));
    a.post("/api/telegram/unlink", async (req) => {
      await unlinkTelegram(req.user!.id);
      return { ok: true };
    });
    a.post("/api/telegram/claim-code", async (req) => {
      const { code } = z.object({ code: z.string().min(8).max(64) }).parse(req.body);
      return claimReverseTelegramCode(req.user!.id, code);
    });

    // Wallets
    a.get("/api/wallets", async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      return walletsOverview(req.user!.id);
    });
    a.post("/api/wallets/sync", async (req) => {
      // Client reports Privy-created / imported wallets so our DB stays in sync.
      const b = z
        .object({
          wallets: z
            .array(
              z.object({
                privyWalletId: z.string(),
                address: addr,
                label: z.string().max(64).optional(),
                source: z.string().optional(),
                imported: z.boolean().optional(),
                hdIndex: z.number().int().nullable().optional(),
                restore: z.boolean().optional(),
              }),
            )
            .max(100),
        })
        .parse(req.body);
      const out = [];
      for (const w of b.wallets) out.push(await syncPrivyWallet(req.user!.id, w));
      await walletSetChanged();
      return { wallets: out };
    });
    a.post("/api/wallets/generate", async (req) => {
      const b = z
        .object({
          count: z.number().int().min(1).max(50),
          labelPrefix: z.string().max(32).optional(),
        })
        .parse(req.body);
      const created = await generateWallets(req.user!, b.count, b.labelPrefix);
      await walletSetChanged();
      return { wallets: created };
    });
    // Raw private keys are NEVER accepted by the API. Client must use Privy importWallet, then POST /api/wallets/sync.
    a.post("/api/wallets/import", async (_req, reply) => {
      return reply.code(403).send({
        error: "Private keys must be imported via Privy in the browser. Use importWallet, then sync addresses.",
        code: "KEY_IMPORT_CLIENT_ONLY",
      });
    });
    a.patch("/api/wallets/:id", async (req) => {
      const b = z.object({ label: z.string().max(64).optional() }).parse(req.body);
      return { wallet: await updateWallet(req.user!.id, (req.params as any).id, b) };
    });
    a.get("/api/wallets/:id/removal-check", async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      await checkRateLimit(req.user!.id, "wallet-removal-check", 20);
      const { checkWalletRemoval } = await import("../users/walletRemoval.js");
      const { privy: _p, ...chk } = await checkWalletRemoval(req.user!, (req.params as any).id);
      return chk;
    });
    a.delete("/api/wallets/:id", async (req) => {
      const b = z
        .object({
          confirm: z.literal("DELETE"),
          mode: z.enum(["delete", "hide"]).default("hide"),
          acknowledge: z.boolean().optional(),
          confirmLabel: z.string().max(64).optional(),
          newMainId: z.string().max(100).optional(),
        })
        .parse(req.body ?? {});
      const { removeWalletForUser } = await import("../users/walletRemoval.js");
      const r = await removeWalletForUser(req.user!, (req.params as any).id, b.mode, {
        acknowledge: b.acknowledge,
        confirmLabel: b.confirmLabel,
        newMainId: b.newMainId,
      });
      await walletSetChanged();
      return { ok: true, ...r };
    });
    a.post("/api/wallets/:id/restore", async (req) => {
      const { restoreWallet } = await import("../users/service.js");
      const wallet = await restoreWallet(req.user!.id, (req.params as any).id);
      await walletSetChanged();
      return { wallet };
    });
    a.post("/api/wallets/:id/main", async (req) => {
      await setMain(req.user!.id, (req.params as any).id);
      return { ok: true };
    });
    a.post("/api/wallets/balances", async (req, reply) => {
      const b = z.object({ chain: z.string(), walletIds: z.array(z.string()).optional(), fresh: z.boolean().optional() }).parse(req.body);
      const c = requireChain(b.chain);
      const pool = getPool(c);
      const list = (await listWallets(req.user!.id)).filter((w: { id: string }) => !b.walletIds || b.walletIds.includes(w.id));
      // Manual "Refresh Balances" skips the cache (rate limited); normal loads use it.
      if (b.fresh) await checkRateLimit(req.user!.id, "balances:fresh", 12);
      const { activitySince } = await import("../core/alchemy/activity.js");
      const changedAt = await activitySince(
        c.key,
        list.map((w) => w.address),
      );
      // One multicall for every uncached wallet (30 s cache, concurrent requests share the in-flight call).
      const bals = await cachedBalances(
        c.key,
        list.map((w) => w.address),
        (missing) => nativeBalancesBatch(pool, missing),
        { fresh: b.fresh, changedAt },
      );
      const asOf = new Date(
        balancesAsOf(
          c.key,
          list.map((w) => w.address),
        ),
      ).toISOString();
      const out = list.map((w: { id: string; address: string }) => {
        const bal = bals.get(w.address.toLowerCase());
        if (bal === undefined || bal instanceof Error)
          return { walletId: w.id, balance: null, error: redactString(String(bal?.message ?? "unavailable")) };
        return { walletId: w.id, balance: formatEther(bal), balanceWei: bal.toString() };
      });
      reply.header("cache-control", "private, no-store");
      return { chain: c.key, nativeSymbol: c.nativeSymbol, asOf, balances: out };
    });

    // Resolve / eligibility / simulate / execute
    a.post("/api/resolve", async (req) => {
      const b = z.object({ input: z.string().min(1).max(500), chain: z.string().optional() }).parse(req.body);
      return resolveCached(b.input, b.chain || undefined);
    });
    a.post("/api/eligibility", async (req) => {
      const b = z
        .object({
          chain: z.string(),
          contract: addr,
          input: z.string().optional(),
          strategy,
          walletIds: z.array(z.string()).optional(),
          quantity: z.number().int().min(1).max(1000).optional(),
          refresh: z.boolean().optional(),
          siwe: z
            .array(
              z.object({
                walletId: z.string().max(100),
                fields: z.record(z.string(), z.string().max(400)),
                signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
              }),
            )
            .max(200)
            .optional(),
          generic: z
            .object({ signature: z.string(), priceWei: z.string().regex(/^\d+$/), tokenId: z.string().regex(/^\d+$/).optional() })
            .optional(),
        })
        .parse(req.body);
      const t = b.refresh ? await refresh(b.chain, b.contract, b.input) : await getResolved(b.chain, b.contract, b.input);
      const r = await checkEligibility(t, b.strategy, req.user!.id, b.walletIds ?? null, b.quantity ?? null, undefined, {
        generic: b.generic,
        openseaWalletLogin: true,
        siwe: b.siwe,
        serverSign: true,
      });
      // OpenSea upcoming-stage verification is always on: the client signs missing wallets silently.
      return { ...r, openseaAutoVerify: true };
    });
    /** OpenSea sign-in messages for the user's own wallets; signed in the browser (Privy), never on the server. */
    a.post("/api/opensea/siwe/prepare", async (req) => {
      const b = z.object({ walletIds: z.array(z.string().max(100)).min(1).max(200) }).parse(req.body);
      const { prepareSiwe } = await import("../core/resolver/openseaAuth.js");
      const mine = (await listWallets(req.user!.id)).filter((w) => b.walletIds.includes(w.id));
      const out = [];
      for (const w of mine) {
        const m = await prepareSiwe(w.address);
        out.push({ walletId: w.id, address: w.address, message: m.text, fields: m.fields });
      }
      return { messages: out };
    });
    a.post("/api/simulate", async (req) => {
      const r = mintReq.parse(req.body) as MintRequest;
      const t = await refresh(r.chain, r.contract, r.input);
      return simulateMint(t, r, req.user!.id);
    });
    a.post("/api/mint/execute", async (req) => {
      const b = z.object({ planId: z.string(), confirmPhrase: z.string() }).parse(req.body);
      const plan = consumePlan<{ request: MintRequest; gasHints: Record<string, string> }>(req.user!.id, b.planId, "mint", b.confirmPhrase);
      return { job: await enqueueMint(req.user!.id, plan.data.request, plan.data.gasHints) };
    });
    a.get("/api/jobs", async (req) => ({ jobs: await listJobs(req.user!.id) }));
    a.get("/api/jobs/:id", async (req) => {
      const j = await getJob(req.user!.id, (req.params as any).id);
      if (!j) throw Object.assign(new Error("job not found"), { statusCode: 404 });
      return { job: j };
    });
    a.post("/api/jobs/:id/cancel", async (req) => {
      await cancelJob(req.user!.id, (req.params as any).id);
      return { ok: true };
    });
    a.get("/api/minted", async (req) => ({ minted: await listMinted(req.user!.id) }));

    // Withdraw (native token, browser-signed, server-validated)
    registerWithdrawRoutes(a);

    // NFTs (cached holdings + browser-signed ERC-721 / ERC-1155 sends)
    registerNftRoutes(a);

    // Admin
    a.register(async (ad) => {
      ad.addHook("onRequest", adminGate);
      ad.get("/api/admin/users", async () => ({ users: await listUsersAdmin() }));
      /** Post-deploy: setWebhook + commands + Mini App menu button. Admin only. */
      ad.post("/api/admin/telegram/setup", async () => {
        const { ensureHousekeepingSchedule } = await import("../jobs/scheduler.js");
        return { ...(await setupTelegramWebhook()), ...(await ensureHousekeepingSchedule()) };
      });
      /** Alchemy Address Activity webhooks: status (GET) or full re-sync (POST). Never returns signing keys. */
      ad.get("/api/admin/alchemy/webhooks", async () => {
        const { webhookStatus } = await import("../core/alchemy/sync.js");
        return webhookStatus();
      });
      ad.post("/api/admin/alchemy/sync", async () => {
        const { syncAlchemyWebhooks } = await import("../core/alchemy/sync.js");
        return syncAlchemyWebhooks({ mode: "full" });
      });
      ad.post("/api/admin/users/:id/disable", async (req) => {
        const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
        await setUserDisabled(req.user!.id, (req.params as any).id, disabled);
        return { ok: true };
      });
    });
  });

  return app;
}
