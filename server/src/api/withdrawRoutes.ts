// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { formatEther } from "ethers";
import { explorerTx, requireChain } from "../config/chains.js";
import { getPool } from "../core/rpc/pool.js";
import { getDb } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { derivedKey } from "../auth/session.js";
import { checkRateLimit, getWallet, listWallets } from "../users/service.js";
import { assembleAndVerify, legacyGasPrice, parseAmount, quoteWallet, validateDestination } from "../core/withdraw.js";
import { log, redactString } from "../util/log.js";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const unsignedTx = z.object({
  type: z.literal(0),
  chainId: z.number().int().positive(),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  value: hex,
  nonce: z.number().int().min(0),
  gasLimit: hex,
  gasPrice: hex,
  data: z.literal("0x"),
});

async function audit(userId: string, action: string, chain: string | null, target: string | null, detail: Record<string, unknown>) {
  try {
    await getDb()
      .insert(auditLog)
      .values({ id: randomUUID(), userId, at: new Date().toISOString(), action, chain, target, detailJson: JSON.stringify(detail) });
  } catch (e: any) {
    log.warn("audit write failed", { action, message: String(e?.message ?? e).slice(0, 120) });
  }
}

/** Withdraw (native token). All routes run behind requireAuth; every wallet is looked up scoped to req.user. */
export function registerWithdrawRoutes(a: FastifyInstance) {
  const secret = () => derivedKey("withdraw-quote");

  a.post("/api/withdraw/quote", async (req) => {
    const b = z
      .object({
        chain: z.string(),
        to: z.string().max(64),
        wallets: z
          .array(z.object({ walletId: z.string().max(100), amount: z.string().max(40) }))
          .min(1)
          .max(100),
      })
      .parse(req.body);
    await checkRateLimit(req.user!.id, "withdraw:quote", 30);
    const chain = requireChain(b.chain);
    const pool = getPool(chain);
    const to = validateDestination(b.to);
    const mine = await listWallets(req.user!.id);
    const byId = new Map(mine.map((w) => [w.id, w]));
    const picked = b.wallets.map((x) => {
      const w = byId.get(x.walletId);
      if (!w) throw Object.assign(new Error("Wallet not found"), { statusCode: 404 });
      return { w, amount: parseAmount(x.amount) };
    });
    const [code, gasPrice, seen] = await Promise.all([
      pool.read((p) => p.getCode(to), "getCode"),
      legacyGasPrice(pool),
      getDb()
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.userId, req.user!.id), eq(auditLog.action, "withdraw.sent"), eq(auditLog.target, to.toLowerCase())))
        .limit(1),
    ]);
    const isContract = code !== "0x";
    const ownWallet = mine.find((w) => w.address.toLowerCase() === to.toLowerCase()) ?? null;
    const items = await Promise.all(
      picked.map(async ({ w, amount }) => {
        if (w.address.toLowerCase() === to.toLowerCase())
          return { walletId: w.id, label: w.label, address: w.address, skip: "source and destination are the same wallet", tx: null };
        try {
          return await quoteWallet(chain, pool, w, to, isContract, amount, gasPrice, req.user!.id, secret());
        } catch (e: any) {
          return {
            walletId: w.id,
            label: w.label,
            address: w.address,
            skip: redactString(String(e?.message ?? e)).slice(0, 200),
            tx: null,
          };
        }
      }),
    );
    const ok = items.filter((i: any) => i.tx);
    const sum = (k: string) => ok.reduce((s: bigint, i: any) => s + BigInt(i[k]), 0n);
    const warnings: string[] = [];
    if (isContract)
      warnings.push("Destination is a smart contract. Make sure it can receive native tokens (exchanges and multisigs may not).");
    if (!seen.length && !ownWallet) warnings.push("You have not withdrawn to this address before. Double-check every character.");
    if (chain.stack === "op")
      warnings.push(
        `${chain.name} charges an L1 data fee. A small buffer is reserved so the transfer can't fail; any unused part stays in the wallet.`,
      );
    if (chain.stack === "arbitrum") warnings.push(`${chain.name} refunds unused gas, so "Max" may leave a tiny refund in the wallet.`);
    await audit(req.user!.id, "withdraw.quote", chain.key, to.toLowerCase(), { wallets: items.length, ready: ok.length });
    return {
      chain: chain.key,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol,
      destination: { address: to, isContract, seenBefore: seen.length > 0, ownWallet: ownWallet ? ownWallet.label : null },
      items,
      totals: {
        valueWei: sum("valueWei").toString(),
        feeWei: sum("feeWei").toString(),
        value: formatEther(sum("valueWei")),
        fee: formatEther(sum("feeWei")),
      },
      warnings,
    };
  });

  a.post("/api/withdraw/send", async (req) => {
    const b = z
      .object({
        chain: z.string(),
        walletId: z.string().max(100),
        tx: unsignedTx,
        quoteToken: z.string().max(200),
        signed: hex.max(20_000),
      })
      .parse(req.body);
    await checkRateLimit(req.user!.id, "withdraw:send", 20);
    const chain = requireChain(b.chain);
    if (b.tx.chainId !== chain.chainId) throw Object.assign(new Error("Chain mismatch"), { statusCode: 400 });
    const w = await getWallet(req.user!.id, b.walletId);
    const { raw } = assembleAndVerify({
      secret: secret(),
      userId: req.user!.id,
      walletId: w.id,
      from: w.address,
      tx: b.tx,
      quoteToken: b.quoteToken,
      signed: b.signed,
    });
    const base = { from: w.address, valueWei: BigInt(b.tx.value).toString(), nonce: b.tx.nonce };
    try {
      const r = await getPool(chain).broadcast(raw);
      await audit(req.user!.id, "withdraw.sent", chain.key, b.tx.to.toLowerCase(), { ...base, hash: r.hash });
      return { hash: r.hash, explorer: explorerTx(chain, r.hash) };
    } catch (e: any) {
      const msg = redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 200);
      await audit(req.user!.id, "withdraw.failed", chain.key, b.tx.to.toLowerCase(), { ...base, error: msg });
      throw Object.assign(new Error(`Broadcast failed: ${msg}`), { statusCode: 502 });
    }
  });

  a.get("/api/withdraw/status", async (req) => {
    const q = z.object({ chain: z.string(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.query);
    const chain = requireChain(q.chain);
    const rc = await getPool(chain)
      .read((p) => p.getTransactionReceipt(q.hash), "receipt")
      .catch(() => null);
    if (!rc) return { status: "pending" };
    return { status: rc.status === 1 ? "confirmed" : "failed", blockNumber: rc.blockNumber, feeWei: (rc.gasUsed * rc.gasPrice).toString() };
  });
}
