import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { formatEther } from "ethers";
import { CHAINS, requireChain, rpcsForChain } from "../config/chains.js";
import { configStatus, env } from "../config/env.js";
import { session } from "../core/keystore/session.js";
import { wallets } from "../core/wallets/service.js";
import { getPool } from "../core/rpc/pool.js";
import { getResolved, refresh } from "../core/resolver/cache.js";
import { checkEligibility } from "../core/mint/eligibility.js";
import { simulateMint } from "../core/mint/simulate.js";
import { consumePlan } from "../core/plans.js";
import { cancelJob, enqueueMint } from "../worker/worker.js";
import { getStore } from "../core/store.js";
import { executeFund, executeSweep, previewFund, previewSweep } from "../core/ops/ops.js";
import { MintRequest } from "../core/mint/types.js";
import { redactString, log } from "../util/log.js";
import { dailySpent, defaultCapValues } from "../core/safety/safety.js";

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

function settingsView() {
  const st = getStore().db.settings;
  return {
    priceCapEnabled: st.priceCapEnabled, dailyCapEnabled: st.dailyCapEnabled, openseaWalletLogin: st.openseaWalletLogin,
    chains: CHAINS.map((c) => { const def = defaultCapValues(c); const v = st.caps[c.key] ?? {}; return { key: c.key, name: c.name, nativeSymbol: c.nativeSymbol, maxPricePerNft: v.maxPricePerNft ?? def.maxPricePerNft, maxDailySpend: v.maxDailySpend ?? def.maxDailySpend, dailySpent: formatEther(dailySpent(c)) }; }),
    alwaysOn: ["chain-ID check before every send", "mint target must be SeaDrop / resolved contract", "approve / setApprovalForAll / transfer-style calls blocked", "OpenSea tx value must not exceed published stage price x qty", "MAX_GAS_PRICE_GWEI fee ceiling"],
  };
}

function auth(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : undefined;
  if (!session.validToken(token)) { reply.code(401).send({ error: session.unlocked ? "Invalid session token" : "Locked — unlock with the master password" }); return; }
  done();
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: [env.dashboardUrl, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err.statusCode ?? (err instanceof z.ZodError ? 400 : 500);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : redactString(String(err.message ?? err));
    if (status >= 500) log.error("API error", err);
    reply.code(status).send({ error: message });
  });

  /* ---------- public ---------- */
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/status", async () => ({
    initialized: session.initialized, unlocked: session.unlocked, sessionExpiresAt: session.expiry,
    config: configStatus(),
    chains: CHAINS.map((c) => { const r = rpcsForChain(c); return { key: c.key, chainId: c.chainId, name: c.name, nativeSymbol: c.nativeSymbol, seadrop: c.seadrop, privateRpc: r.hasPrivate, rpcCount: r.read.length, sendRpcCount: r.send.length }; }),
  }));
  app.post("/api/session/unlock", async (req) => {
    const { password } = z.object({ password: z.string().min(8).max(256) }).parse(req.body);
    return session.unlock(password);
  });

  /* ---------- authenticated ---------- */
  app.register(async (a) => {
    a.addHook("onRequest", auth);
    a.post("/api/session/lock", async () => { session.lock("manual"); return { ok: true }; });

    a.get("/api/chains/health", async () => Promise.all(CHAINS.map(async (c) => {
      const pool = getPool(c);
      let ok = false; let error: string | null = null; let block: number | null = null;
      try { await pool.checkChainId(); block = await pool.read((p) => p.getBlockNumber(), "blockNumber"); ok = true; } catch (e: any) { error = redactString(e.message); }
      return { key: c.key, chainId: c.chainId, ok, block, error, endpoints: pool.status().map((s) => ({ ...s, lastError: s.lastError ? redactString(s.lastError) : null })) };
    })));

    // Settings (caps default OFF = unlimited; chain-ID check and approve/transfer block always on)
    a.get("/api/settings", async () => settingsView());
    a.put("/api/settings", async (req) => {
      const num = z.string().regex(/^\d+(\.\d+)?$/);
      const b = z.object({ priceCapEnabled: z.boolean().optional(), dailyCapEnabled: z.boolean().optional(), openseaWalletLogin: z.boolean().optional(),
        caps: z.record(z.string(), z.object({ maxPricePerNft: num.optional(), maxDailySpend: num.optional() })).optional() }).parse(req.body);
      for (const k of Object.keys(b.caps ?? {})) requireChain(k);
      getStore().update((d) => {
        if (b.priceCapEnabled !== undefined) d.settings.priceCapEnabled = b.priceCapEnabled;
        if (b.dailyCapEnabled !== undefined) d.settings.dailyCapEnabled = b.dailyCapEnabled;
        if (b.openseaWalletLogin !== undefined) d.settings.openseaWalletLogin = b.openseaWalletLogin;
        for (const [k, v] of Object.entries(b.caps ?? {})) d.settings.caps[k] = { ...d.settings.caps[k], ...v };
      });
      log.info("Settings updated", { priceCapEnabled: getStore().db.settings.priceCapEnabled, dailyCapEnabled: getStore().db.settings.dailyCapEnabled, openseaWalletLogin: getStore().db.settings.openseaWalletLogin });
      return settingsView();
    });

    // Wallets
    a.get("/api/wallets", async () => ({ wallets: wallets.list(), groups: wallets.groups(), mainWalletId: getStore().db.mainWalletId }));
    a.post("/api/wallets/import", async (req) => {
      const b = z.object({ key: z.string().max(200), label: z.string().max(64).default(""), group: z.string().max(48).nullable().optional() }).parse(req.body);
      return { wallet: wallets.importOne(b.key, b.label, b.group ?? null) };
    });
    a.post("/api/wallets/import-bulk", async (req) => {
      const b = z.object({ text: z.string().max(1_000_000), group: z.string().max(48).nullable().optional(), labelPrefix: z.string().max(32).optional() }).parse(req.body);
      const r = wallets.importBulk(b.text, b.group ?? null, b.labelPrefix);
      return { imported: r.imported.length, duplicates: r.duplicates, invalidLines: r.invalidLines, wallets: r.imported };
    });
    a.post("/api/wallets/generate", async (req) => {
      const b = z.object({ count: z.number().int().min(1).max(500), group: z.string().max(48).nullable().optional(), labelPrefix: z.string().max(32).optional() }).parse(req.body);
      return { wallets: wallets.generate(b.count, b.group ?? null, b.labelPrefix) };
    });
    a.patch("/api/wallets/:id", async (req) => {
      const b = z.object({ label: z.string().max(64).optional(), group: z.string().max(48).nullable().optional() }).parse(req.body);
      return { wallet: wallets.update((req.params as any).id, b) };
    });
    a.delete("/api/wallets/:id", async (req) => {
      const b = z.object({ confirm: z.literal("DELETE") }).parse(req.body ?? {});
      void b; wallets.remove((req.params as any).id); return { ok: true };
    });
    a.post("/api/wallets/:id/main", async (req) => { wallets.setMain((req.params as any).id); return { ok: true }; });
    a.post("/api/groups", async (req) => { wallets.createGroup(z.object({ name: z.string() }).parse(req.body).name); return { groups: wallets.groups() }; });
    a.delete("/api/groups/:name", async (req) => { wallets.deleteGroup(decodeURIComponent((req.params as any).name)); return { groups: wallets.groups() }; });
    a.post("/api/wallets/balances", async (req) => {
      const b = z.object({ chain: z.string(), walletIds: z.array(z.string()).optional() }).parse(req.body);
      const c = requireChain(b.chain); const pool = getPool(c);
      const list = wallets.list().filter((w) => !b.walletIds || b.walletIds.includes(w.id));
      const out = await Promise.all(list.map(async (w) => {
        try { const bal = await pool.read((p) => p.getBalance(w.address), "balance"); return { walletId: w.id, balance: formatEther(bal), balanceWei: bal.toString() }; }
        catch (e: any) { return { walletId: w.id, balance: null, error: redactString(e.message) }; }
      }));
      return { chain: c.key, nativeSymbol: c.nativeSymbol, balances: out };
    });

    // Resolve / eligibility / simulate / execute
    a.post("/api/resolve", async (req) => {
      const b = z.object({ input: z.string().min(1).max(500), chain: z.string().optional() }).parse(req.body);
      const { resolveTarget } = await import("../core/resolver/resolver.js");
      const { remember } = await import("../core/resolver/cache.js");
      return remember(await resolveTarget({ input: b.input, chain: b.chain || undefined }));
    });
    a.post("/api/eligibility", async (req) => {
      const b = z.object({ chain: z.string(), contract: addr, input: z.string().optional(), strategy, walletIds: z.array(z.string()).optional(), quantity: z.number().int().min(1).max(100).default(1), refresh: z.boolean().optional(),
        generic: z.object({ signature: z.string(), priceWei: z.string().regex(/^\d+$/), tokenId: z.string().regex(/^\d+$/).optional() }).optional() }).parse(req.body);
      const t = b.refresh ? await refresh(b.chain, b.contract, b.input) : await getResolved(b.chain, b.contract, b.input);
      return checkEligibility(t, b.strategy, b.walletIds ?? null, b.quantity, undefined, { generic: b.generic, openseaWalletLogin: getStore().db.settings.openseaWalletLogin });
    });
    a.post("/api/simulate", async (req) => {
      const r = mintReq.parse(req.body) as MintRequest;
      const t = await refresh(r.chain, r.contract, r.input); // always fresh on-chain state before a spend decision
      return simulateMint(t, r);
    });
    a.post("/api/mint/execute", async (req) => {
      const b = z.object({ planId: z.string(), confirmPhrase: z.string() }).parse(req.body);
      const plan = consumePlan<{ request: MintRequest; gasHints: Record<string, string> }>(b.planId, "mint", b.confirmPhrase);
      session.requireKek();
      return { job: enqueueMint(plan.data.request, plan.data.gasHints) };
    });
    a.get("/api/jobs", async () => ({ jobs: getStore().db.jobs.slice(0, 100) }));
    a.get("/api/jobs/:id", async (req) => {
      const j = getStore().db.jobs.find((x) => x.id === (req.params as any).id);
      if (!j) throw Object.assign(new Error("job not found"), { statusCode: 404 });
      return { job: j };
    });
    a.post("/api/jobs/:id/cancel", async (req) => { cancelJob((req.params as any).id); return { ok: true }; });
    a.get("/api/minted", async () => ({ minted: getStore().db.minted.slice(-500).reverse() }));

    // Ops (both require preview -> typed confirmation phrase)
    a.post("/api/ops/fund/preview", async (req) => previewFund(z.object({ chain: z.string(), fromWalletId: z.string().optional(), walletIds: z.array(z.string()).min(1), amountEach: z.string().regex(/^\d+(\.\d+)?$/), topUpTo: z.boolean().optional() }).parse(req.body)));
    a.post("/api/ops/fund/execute", async (req) => { const b = z.object({ planId: z.string(), confirmPhrase: z.string() }).parse(req.body); return executeFund(b.planId, b.confirmPhrase); });
    a.post("/api/ops/sweep/preview", async (req) => previewSweep(z.object({ chain: z.string(), contract: addr, walletIds: z.array(z.string()).min(1), vault: addr.optional(), tokenIds: z.array(z.string().regex(/^\d+$/)).optional() }).parse(req.body)));
    a.post("/api/ops/sweep/execute", async (req) => { const b = z.object({ planId: z.string(), confirmPhrase: z.string() }).parse(req.body); return executeSweep(b.planId, b.confirmPhrase); });
  });

  return app;
}
