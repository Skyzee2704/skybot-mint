import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { formatEther } from "ethers";
import { CHAINS, requireChain, rpcsForChain } from "../config/chains.js";
import { configStatus, env, privyConfigured, privyServerSigningReady } from "../config/env.js";
import { requireAuth } from "../auth/middleware.js";
import { getPool } from "../core/rpc/pool.js";
import { getResolved, refresh, remember } from "../core/resolver/cache.js";
import { checkEligibility } from "../core/mint/eligibility.js";
import { simulateMint } from "../core/mint/simulate.js";
import { consumePlan } from "../core/plans.js";
import { cancelJob, enqueueMint } from "../worker/worker.js";
import { listJobs, getJob, listMinted } from "../core/jobs/repo.js";
import {
  publicUser, listWallets, listGroups, generateWallets, syncPrivyWallet,
  updateWallet, removeWallet, setMain, createGroup, deleteGroup,
  getSettings, updateSettings, createTelegramLinkCode, claimReverseTelegramCode, unlinkTelegram,
  listUsersAdmin, setUserDisabled, userByTelegram, requireUser,
} from "../users/service.js";
import { defaultCapValues, dailySpent } from "../core/safety/safety.js";
import { MintRequest } from "../core/mint/types.js";
import { redactString, log } from "../util/log.js";
import { dbMode } from "../db/client.js";
import { validateInitData, publicHttpsReady } from "../bot/telegramWebApp.js";
import { webhookCallback } from "../bot/telegram.js";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const strategy = z.enum(["seadrop_public", "opensea_api", "generic"]);
const mintReq = z.object({
  chain: z.string(), contract: addr, input: z.string().optional(), strategy, slug: z.string().nullable().optional(),
  wallets: z.array(z.object({ walletId: z.string(), quantity: z.number().int().min(1).max(100) })).min(1).max(500),
  generic: z.object({ signature: z.string(), priceWei: z.string().regex(/^\d+$/), tokenId: z.string().regex(/^\d+$/).optional() }).optional(),
  gasMode: z.enum(["eco", "normal", "aggressive"]).optional(),
  gasLimit: z.number().int().min(21000).max(5_000_000).optional(),
  runAt: z.string().datetime().nullable().optional(),
  offsetMs: z.number().int().min(-5000).max(60000).optional(),
});

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
    allowedHeaders: ["Authorization", "Content-Type", "Privy-Id-Token", "X-Telegram-Init-Data"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err.statusCode ?? (err instanceof z.ZodError ? 400 : 500);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : redactString(String(err.message ?? err));
    if (status >= 500) log.error("API error", err);
    reply.code(status).send({ error: message, code: err.code });
  });

  /* ---------- public ---------- */
  app.get("/api/health", async () => ({
    ok: true, brand: "SkyBOT Mint", db: dbMode(),
    miniApp: publicHttpsReady(), webhook: Boolean(env.publicApiUrl),
  }));

  /** Mini App fallback auth: validate Telegram initData HMAC → linked SkyBOT user. */
  app.post("/api/telegram/session", async (req) => {
    const { initData } = z.object({ initData: z.string().min(10) }).parse(req.body);
    const v = validateInitData(initData);
    const u = await userByTelegram(String(v.user.id));
    if (!u) {
      return {
        linked: false,
        telegram: { id: v.user.id, username: v.user.username ?? null },
        hint: "Link via Settings → Connect Telegram, or /link in the bot.",
      };
    }
    return { linked: true, user: publicUser(u), telegram: { id: v.user.id, username: v.user.username ?? null } };
  });

  /** Telegram webhook (production). Secret compared to TELEGRAM_WEBHOOK_SECRET. */
  app.post("/api/telegram/webhook", async (req, reply) => {
    // Only active in webhook mode, and the secret is ALWAYS required (else anyone could forge Telegram user ids).
    const secret = env.telegramWebhookSecret;
    if (!env.publicApiUrl || !secret) return reply.code(404).send({ error: "not found" });
    const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    const { timingSafeEqual } = await import("node:crypto");
    const a = Buffer.from(got), b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "bad secret" });
    const handler = webhookCallback();
    if (!handler) return reply.code(503).send({ error: "bot not ready" });
    return handler(req, reply);
  });
  app.get("/api/status", async () => ({
    brand: "SkyBOT Mint",
    privyConfigured: privyConfigured(),
    privyAppId: env.privyAppId ?? null,
    serverSigning: privyServerSigningReady(),
    config: configStatus(),
    setup: !privyConfigured() ? {
      title: "Privy setup required",
      steps: [
        "Create an app at https://dashboard.privy.io (or use the existing SkyBOT Mint app)",
        "Set PRIVY_APP_ID and PRIVY_APP_SECRET in the environment",
        "Enable Email and Google login methods",
        "Add your domain(s) under Allowed origins (include http://localhost:3000 for local)",
        "Embedded wallets: create on login = all users (or create on demand)",
        "For scheduled mints: create an authorization key, register a key quorum, set PRIVY_AUTH_PRIVATE_KEY + PRIVY_AUTH_KEY_QUORUM_ID, and add the quorum as a session signer on user wallets",
      ],
    } : null,
    chains: CHAINS.map((c) => { const r = rpcsForChain(c); return { key: c.key, chainId: c.chainId, name: c.name, nativeSymbol: c.nativeSymbol, seadrop: c.seadrop, privateRpc: r.hasPrivate, rpcCount: r.read.length, sendRpcCount: r.send.length }; }),
  }));

  /* ---------- authenticated ---------- */
  app.register(async (a) => {
    a.addHook("onRequest", requireAuth);

    a.get("/api/me", async (req) => ({ user: publicUser(req.user!), serverSigning: privyServerSigningReady() }));

    a.get("/api/chains/health", async () => Promise.all(CHAINS.map(async (c) => {
      const pool = getPool(c);
      let ok = false; let error: string | null = null; let block: number | null = null;
      try { await pool.checkChainId(); block = await pool.read((p) => p.getBlockNumber(), "blockNumber"); ok = true; } catch (e: any) { error = redactString(e.message); }
      return { key: c.key, chainId: c.chainId, ok, block, error, endpoints: pool.status().map((s) => ({ ...s, lastError: s.lastError ? redactString(s.lastError) : null })) };
    })));

    // Settings
    a.get("/api/settings", async (req) => {
      const st = await getSettings(req.user!.id);
      return {
        ...st,
        chains: await Promise.all(CHAINS.map(async (c) => { const def = defaultCapValues(c); const v = st.caps[c.key] ?? {}; return { key: c.key, name: c.name, nativeSymbol: c.nativeSymbol, maxPricePerNft: v.maxPricePerNft ?? def.maxPricePerNft, maxDailySpend: v.maxDailySpend ?? def.maxDailySpend, dailySpent: formatEther(await dailySpent(req.user!.id, c)) }; })),
        alwaysOn: ["chain-ID check", "mint target must be SeaDrop / resolved contract", "approve / transfer-style calls blocked", "OpenSea tx value ≤ stage price × qty", "MAX_GAS_PRICE_GWEI"],
        telegram: { linked: Boolean(req.user!.telegramUserId), username: req.user!.telegramUsername, botUsername: env.telegramBotUsername ?? null },
      };
    });
    a.put("/api/settings", async (req) => {
      const num = z.string().regex(/^\d+(\.\d+)?$/);
      const b = z.object({ priceCapEnabled: z.boolean().optional(), dailyCapEnabled: z.boolean().optional(), openseaWalletLogin: z.boolean().optional(),
        caps: z.record(z.string(), z.object({ maxPricePerNft: num.optional(), maxDailySpend: num.optional() })).optional() }).parse(req.body);
      for (const k of Object.keys(b.caps ?? {})) requireChain(k);
      return updateSettings(req.user!.id, b);
    });

    // Telegram link (web ↔ bot) — works without public domain
    a.post("/api/telegram/link-code", async (req) => createTelegramLinkCode(req.user!.id));
    a.post("/api/telegram/unlink", async (req) => { await unlinkTelegram(req.user!.id); return { ok: true }; });
    a.post("/api/telegram/claim-code", async (req) => {
      const { code } = z.object({ code: z.string().min(8).max(64) }).parse(req.body);
      return claimReverseTelegramCode(req.user!.id, code);
    });

    // Wallets
    a.get("/api/wallets", async (req) => ({ wallets: await listWallets(req.user!.id), groups: await listGroups(req.user!.id) }));
    a.post("/api/wallets/sync", async (req) => {
      // Client reports Privy-created / imported wallets so our DB stays in sync.
      const b = z.object({ wallets: z.array(z.object({ privyWalletId: z.string(), address: addr, label: z.string().max(64).optional(), group: z.string().max(48).nullable().optional(), source: z.string().optional(), hdIndex: z.number().int().nullable().optional() })).max(100) }).parse(req.body);
      const out = [];
      for (const w of b.wallets) out.push(await syncPrivyWallet(req.user!.id, w));
      return { wallets: out };
    });
    a.post("/api/wallets/generate", async (req) => {
      const b = z.object({ count: z.number().int().min(1).max(50), group: z.string().max(48).nullable().optional(), labelPrefix: z.string().max(32).optional() }).parse(req.body);
      return { wallets: await generateWallets(req.user!, b.count, b.group ?? null, b.labelPrefix) };
    });
    // Raw private keys are NEVER accepted by the API. Client must use Privy importWallet, then POST /api/wallets/sync.
    a.post("/api/wallets/import", async (_req, reply) => {
      return reply.code(403).send({
        error: "Private keys must be imported via Privy in the browser. Use importWallet, then sync addresses.",
        code: "KEY_IMPORT_CLIENT_ONLY",
      });
    });
    a.patch("/api/wallets/:id", async (req) => {
      const b = z.object({ label: z.string().max(64).optional(), group: z.string().max(48).nullable().optional() }).parse(req.body);
      return { wallet: await updateWallet(req.user!.id, (req.params as any).id, b) };
    });
    a.delete("/api/wallets/:id", async (req) => {
      z.object({ confirm: z.literal("DELETE") }).parse(req.body ?? {});
      await removeWallet(req.user!.id, (req.params as any).id); return { ok: true };
    });
    a.post("/api/wallets/:id/main", async (req) => { await setMain(req.user!.id, (req.params as any).id); return { ok: true }; });
    a.post("/api/groups", async (req) => ({ groups: await createGroup(req.user!.id, z.object({ name: z.string() }).parse(req.body).name) }));
    a.delete("/api/groups/:name", async (req) => ({ groups: await deleteGroup(req.user!.id, decodeURIComponent((req.params as any).name)) }));
    a.post("/api/wallets/balances", async (req) => {
      const b = z.object({ chain: z.string(), walletIds: z.array(z.string()).optional() }).parse(req.body);
      const c = requireChain(b.chain); const pool = getPool(c);
      const list = (await listWallets(req.user!.id)).filter((w: { id: string }) => !b.walletIds || b.walletIds.includes(w.id));
      const out = await Promise.all(list.map(async (w: { id: string; address: string }) => {
        try { const bal = await pool.read((p) => p.getBalance(w.address), "balance"); return { walletId: w.id, balance: formatEther(bal), balanceWei: bal.toString() }; }
        catch (e: any) { return { walletId: w.id, balance: null, error: redactString(e.message) }; }
      }));
      return { chain: c.key, nativeSymbol: c.nativeSymbol, balances: out };
    });

    // Resolve / eligibility / simulate / execute
    a.post("/api/resolve", async (req) => {
      const b = z.object({ input: z.string().min(1).max(500), chain: z.string().optional() }).parse(req.body);
      const { resolveTarget } = await import("../core/resolver/resolver.js");
      return remember(await resolveTarget({ input: b.input, chain: b.chain || undefined }));
    });
    a.post("/api/eligibility", async (req) => {
      const b = z.object({ chain: z.string(), contract: addr, input: z.string().optional(), strategy, walletIds: z.array(z.string()).optional(), quantity: z.number().int().min(1).max(100).default(1), refresh: z.boolean().optional(),
        generic: z.object({ signature: z.string(), priceWei: z.string().regex(/^\d+$/), tokenId: z.string().regex(/^\d+$/).optional() }).optional() }).parse(req.body);
      const t = b.refresh ? await refresh(b.chain, b.contract, b.input) : await getResolved(b.chain, b.contract, b.input);
      const st = await getSettings(req.user!.id);
      return checkEligibility(t, b.strategy, req.user!.id, b.walletIds ?? null, b.quantity, undefined, { generic: b.generic, openseaWalletLogin: st.openseaWalletLogin });
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
    a.post("/api/jobs/:id/cancel", async (req) => { await cancelJob(req.user!.id, (req.params as any).id); return { ok: true }; });
    a.get("/api/minted", async (req) => ({ minted: await listMinted(req.user!.id) }));

    // Admin
    a.register(async (ad) => {
      ad.addHook("onRequest", async (req, reply) => { if (req.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" }); });
      ad.get("/api/admin/users", async () => ({ users: await listUsersAdmin() }));
      ad.post("/api/admin/users/:id/disable", async (req) => {
        const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
        await setUserDisabled(req.user!.id, (req.params as any).id, disabled);
        return { ok: true };
      });
    });
  });

  return app;
}

