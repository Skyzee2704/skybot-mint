// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NFTs page: cached holdings (DB only), indexer refresh with cooldown, and browser-signed ERC-721 / ERC-1155 sends.
 * All routes run behind requireAuth; every wallet is looked up scoped to req.user.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { Contract, Signature, Transaction, getAddress, toBeHex } from "ethers";
import { explorerTx, requireChain, type ChainConfig } from "../config/chains.js";
import { getPool, type RpcPool } from "../core/rpc/pool.js";
import { aggregate, nativeBalancesBatch } from "../core/rpc/multicall.js";
import { getDb } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { derivedKey } from "../auth/session.js";
import { checkRateLimit, getWallet, listWallets } from "../users/service.js";
import { OP_GAS_PRICE_ORACLE, legacyGasPrice, validateDestination, L1_FEE_BUFFER_PCT } from "../core/withdraw.js";
import { applyTransferToCache, holdingsView, refreshHoldings } from "../core/nft/holdings.js";
import {
  NFT_GAS_BUFFER_PCT,
  NFT_QUOTE_TTL_MS,
  encodeTransfer,
  heldFrom,
  ownershipCall,
  planWalletGas,
  signNftQuote,
  verifySignedNftTx,
  type UnsignedNftTx,
} from "../core/nft/transfer.js";
import { invalidateBalances } from "../util/balanceCache.js";
import { log, redactString } from "../util/log.js";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const unsignedNftTx = z.object({
  type: z.literal(0),
  chainId: z.number().int().positive(),
  to: addr,
  value: z.literal("0x0"),
  nonce: z.number().int().min(0),
  gasLimit: hex,
  gasPrice: hex,
  data: hex.max(2000),
});
const quoteItem = z.object({
  walletId: z.string().max(100),
  chain: z.string().max(32),
  contract: addr,
  tokenId: z.string().regex(/^\d{1,80}$/),
  standard: z.enum(["erc721", "erc1155"]),
  quantity: z
    .string()
    .regex(/^\d{1,40}$/)
    .optional(),
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

async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await fn(xs[k]);
      }
    }),
  );
  return out;
}

/** Bytes the OP GasPriceOracle prices: the tx as it will be signed (dummy signature, same size). */
function l1Sized(tx: { to: string; data: string; nonce: number; gasLimit: bigint; gasPrice: bigint; chainId: number }) {
  const t = Transaction.from({
    type: 0,
    to: tx.to,
    value: 0n,
    data: tx.data,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    chainId: tx.chainId,
  });
  t.signature = Signature.from({ r: "0x" + "ff".repeat(32), s: "0x" + "7f".repeat(32), v: 27 });
  return t.serialized;
}

type Wallet = { id: string; label: string; address: string };
type In = z.infer<typeof quoteItem> & { w: Wallet };

async function quoteChain(chain: ChainConfig, pool: RpcPool, to: string, items: In[], userId: string, secret: Buffer) {
  const wallets = [...new Map(items.map((i) => [i.w.id, i.w])).values()];
  // Fresh reads, batched: destination code, gas price, every source balance (1 multicall), ownership (1 multicall).
  const [code, gasPrice, balances, owned, nonces] = await Promise.all([
    pool.read((p) => p.getCode(to), "getCode"),
    legacyGasPrice(pool),
    nativeBalancesBatch(
      pool,
      wallets.map((w) => w.address),
    ),
    aggregate(
      pool,
      items.map((i) => ({ target: i.contract, data: ownershipCall(i.standard, i.w.address, BigInt(i.tokenId)) })),
      "ownership",
    ),
    Promise.all(wallets.map(async (w) => [w.id, await pool.read((p) => p.getTransactionCount(w.address, "pending"), "nonce")] as const)),
  ]);
  const isContract = code !== "0x";
  const nonceOf = new Map(nonces);

  // Per item: ownership + quantity, then a gas estimate for the exact calldata (also catches receivers that reject).
  const pre = await mapLimit(
    items.map((i, idx) => ({ i, idx })),
    4,
    async ({ i, idx }) => {
      const base = {
        key: `${i.w.id}:${chain.key}:${getAddress(i.contract)}:${i.tokenId}`,
        walletId: i.w.id,
        label: i.w.label,
        address: i.w.address,
        chain: chain.key,
        contract: getAddress(i.contract),
        tokenId: i.tokenId,
        standard: i.standard,
      };
      if (i.w.address.toLowerCase() === to.toLowerCase())
        return {
          ...base,
          quantity: "0",
          held: null as string | null,
          gasLimit: 0n,
          data: "",
          skip: "source and destination are the same wallet",
        };
      const held = heldFrom(i.standard, i.w.address, owned[idx].success, owned[idx].returnData);
      if (held === null)
        return { ...base, quantity: "0", held: null, gasLimit: 0n, data: "", skip: "could not verify ownership (unsupported contract)" };
      if (held === 0n)
        return { ...base, quantity: "0", held: "0", gasLimit: 0n, data: "", skip: "no longer held by this wallet. Refresh holdings" };
      const want = i.standard === "erc721" ? 1n : BigInt(i.quantity ?? "1");
      if (want < 1n) return { ...base, quantity: "0", held: held.toString(), gasLimit: 0n, data: "", skip: "quantity must be at least 1" };
      if (want > held)
        return { ...base, quantity: want.toString(), held: held.toString(), gasLimit: 0n, data: "", skip: `only ${held} held` };
      const data = encodeTransfer(i.standard, getAddress(i.w.address), to, BigInt(i.tokenId), want);
      try {
        const est = await pool.read((p) => p.estimateGas({ from: i.w.address, to: i.contract, data }), "estimateGas");
        return {
          ...base,
          quantity: want.toString(),
          held: held.toString(),
          gasLimit: (est * NFT_GAS_BUFFER_PCT + 99n) / 100n,
          data,
          skip: null as string | null,
        };
      } catch (e: any) {
        const m = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e);
        const why = /insufficient funds/i.test(m)
          ? "not enough native token for gas"
          : isContract
            ? "transfer would fail: the destination contract may not accept NFTs"
            : `transfer would fail: ${redactString(m).slice(0, 120)}`;
        return { ...base, quantity: want.toString(), held: held.toString(), gasLimit: 0n, data, skip: why };
      }
    },
  );

  // OP Stack L1 data fee: one oracle read per chain for the largest transfer, reserved (buffered) for every item.
  let l1Fee = 0n;
  const sized = pre.filter((p) => !p.skip);
  if (chain.stack === "op" && sized.length) {
    const big = sized.reduce((a, b) => (b.data.length > a.data.length ? b : a));
    const raw = await pool.read(
      (p) =>
        new Contract(OP_GAS_PRICE_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], p).getL1Fee(
          l1Sized({ to: big.contract, data: big.data, nonce: 1_000_000, gasLimit: big.gasLimit, gasPrice, chainId: chain.chainId }),
        ) as Promise<bigint>,
      "getL1Fee",
    );
    l1Fee = (raw * L1_FEE_BUFFER_PCT + 99n) / 100n;
  }

  // Gas check per wallet: include transfers in order while the balance covers their fees; skip the rest.
  const exp = Date.now() + NFT_QUOTE_TTL_MS;
  const out = [];
  const short: { walletId: string; label: string; needWei: string; haveWei: string }[] = [];
  for (const w of wallets) {
    const mine = pre.filter((p) => p.walletId === w.id);
    const bal = balances.get(w.address.toLowerCase()) ?? 0n;
    const plan = planWalletGas(
      bal,
      gasPrice,
      mine.filter((p) => !p.skip).map((p) => ({ key: p.key, gasLimit: p.gasLimit, l1Fee })),
    );
    if (plan.needed > bal) short.push({ walletId: w.id, label: w.label, needWei: plan.needed.toString(), haveWei: bal.toString() });
    let nonce = nonceOf.get(w.id)!;
    for (const p of mine) {
      const g = plan.items.find((x) => x.key === p.key);
      const skip = p.skip ?? g?.skip ?? null;
      let tx: UnsignedNftTx | null = null;
      if (!skip) {
        tx = {
          type: 0,
          chainId: chain.chainId,
          to: p.contract,
          value: "0x0",
          nonce: nonce++,
          gasLimit: toBeHex(p.gasLimit),
          gasPrice: toBeHex(gasPrice),
          data: p.data,
        };
      }
      out.push({
        key: p.key,
        walletId: p.walletId,
        label: p.label,
        address: p.address,
        chain: chain.key,
        chainName: chain.name,
        nativeSymbol: chain.nativeSymbol,
        contract: p.contract,
        tokenId: p.tokenId,
        standard: p.standard,
        quantity: p.quantity,
        held: p.held,
        feeWei: g ? g.fee.toString() : "0",
        balanceWei: bal.toString(),
        skip,
        tx,
        quoteToken: tx ? signNftQuote(secret, userId, p.walletId, p.address, tx, exp) : null,
      });
    }
  }
  return { chain: chain.key, chainName: chain.name, nativeSymbol: chain.nativeSymbol, isContract, items: out, gasShort: short };
}

export function registerNftRoutes(a: FastifyInstance) {
  const secret = () => derivedKey("nft-transfer-quote");

  /** Cached holdings only (DB). Never calls an indexer or RPC. */
  a.get("/api/nfts", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    return holdingsView(req.user!.id);
  });

  a.post("/api/nfts/refresh", async (req, reply) => {
    const b = z.object({ mode: z.enum(["missing", "all", "continue"]).default("missing") }).parse(req.body ?? {});
    await checkRateLimit(req.user!.id, "nfts:refresh", 12);
    try {
      const r = await refreshHoldings(req.user!.id, b.mode);
      return { ...r, ...(await holdingsView(req.user!.id)) };
    } catch (e: any) {
      if (e?.code === "COOLDOWN") return reply.code(429).send({ error: e.message, code: e.code, retryAfterMs: e.retryAfterMs });
      throw e;
    }
  });

  a.post("/api/nfts/send/quote", async (req) => {
    const b = z.object({ to: z.string().max(64), items: z.array(quoteItem).min(1).max(100) }).parse(req.body);
    await checkRateLimit(req.user!.id, "nfts:quote", 20);
    const to = validateDestination(b.to);
    const mine = await listWallets(req.user!.id);
    const byId = new Map(mine.map((w) => [w.id, w]));
    const seenKey = new Set<string>();
    const items: In[] = [];
    for (const x of b.items) {
      const w = byId.get(x.walletId);
      if (!w) throw Object.assign(new Error("Wallet not found"), { statusCode: 404 });
      requireChain(x.chain);
      const k = `${w.id}:${x.chain}:${x.contract.toLowerCase()}:${x.tokenId}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      items.push({ ...x, chain: requireChain(x.chain).key, w });
    }
    const byChain = new Map<string, In[]>();
    for (const i of items) byChain.set(i.chain, [...(byChain.get(i.chain) ?? []), i]);
    const [chains, seen] = await Promise.all([
      Promise.all(
        [...byChain].map(async ([key, list]) => {
          const chain = requireChain(key);
          try {
            return await quoteChain(chain, getPool(chain), to, list, req.user!.id, secret());
          } catch (e: any) {
            const why = `could not prepare on ${chain.name}: ${redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 140)}`;
            return {
              chain: chain.key,
              chainName: chain.name,
              nativeSymbol: chain.nativeSymbol,
              isContract: false,
              gasShort: [],
              items: list.map((i) => ({
                key: `${i.w.id}:${chain.key}:${getAddress(i.contract)}:${i.tokenId}`,
                walletId: i.w.id,
                label: i.w.label,
                address: i.w.address,
                chain: chain.key,
                chainName: chain.name,
                nativeSymbol: chain.nativeSymbol,
                contract: getAddress(i.contract),
                tokenId: i.tokenId,
                standard: i.standard,
                quantity: i.quantity ?? "1",
                held: null,
                feeWei: "0",
                balanceWei: "0",
                skip: why,
                tx: null,
                quoteToken: null,
              })),
            };
          }
        }),
      ),
      getDb()
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.userId, req.user!.id), eq(auditLog.action, "nft.sent"), eq(auditLog.target, to.toLowerCase())))
        .limit(1),
    ]);
    const ownWallet = mine.find((w) => w.address.toLowerCase() === to.toLowerCase()) ?? null;
    const contractOn = chains.filter((c) => c.isContract).map((c) => c.chainName);
    const warnings: string[] = [];
    if (contractOn.length)
      warnings.push(
        `Destination is a smart contract on ${contractOn.join(", ")}. Transfers are only prepared if the contract accepts NFTs; exchanges and some multisigs may not.`,
      );
    for (const c of chains)
      for (const s of c.gasShort)
        warnings.push(`${s.label} lacks ${c.nativeSymbol} for gas on ${c.chainName}; transfers it can't pay for are skipped.`);
    if (!seen.length && !ownWallet) warnings.push("You have not sent NFTs to this address before. Double-check every character.");
    const all = chains.flatMap((c) => c.items);
    await audit(req.user!.id, "nft.quote", null, to.toLowerCase(), { items: all.length, ready: all.filter((i) => i.tx).length });
    return {
      destination: {
        address: to,
        isContract: contractOn.length > 0,
        contractOn,
        ownWallet: ownWallet ? ownWallet.label : null,
        seenBefore: seen.length > 0,
      },
      chains: chains.map(({ items: _i, ...c }) => c),
      items: all,
      warnings,
    };
  });

  a.post("/api/nfts/send", async (req) => {
    const b = z
      .object({
        chain: z.string(),
        walletId: z.string().max(100),
        tx: unsignedNftTx,
        quoteToken: z.string().max(200),
        signed: hex.max(20_000),
      })
      .parse(req.body);
    await checkRateLimit(req.user!.id, "nfts:send", 60);
    const chain = requireChain(b.chain);
    if (b.tx.chainId !== chain.chainId) throw Object.assign(new Error("Chain mismatch"), { statusCode: 400 });
    const w = await getWallet(req.user!.id, b.walletId);
    const { raw, transfer } = verifySignedNftTx({
      secret: secret(),
      userId: req.user!.id,
      walletId: w.id,
      from: w.address,
      tx: b.tx,
      quoteToken: b.quoteToken,
      signed: b.signed,
    });
    const detail = {
      from: w.address,
      contract: b.tx.to,
      tokenId: transfer.tokenId.toString(),
      quantity: transfer.quantity.toString(),
      standard: transfer.standard,
      nonce: b.tx.nonce,
    };
    try {
      const r = await getPool(chain).broadcast(raw);
      if (!r.accepted.length) throw new Error(r.errors[0]?.error ?? "no RPC accepted the transaction");
      invalidateBalances(chain.key, [w.address]);
      await audit(req.user!.id, "nft.sent", chain.key, transfer.to.toLowerCase(), { ...detail, hash: r.hash });
      await applyTransferToCache(req.user!.id, {
        walletId: w.id,
        chain: chain.key,
        contract: b.tx.to,
        tokenId: transfer.tokenId.toString(),
        quantity: transfer.quantity,
        destination: transfer.to,
      }).catch((e) => log.warn("nft cache update failed", String(e?.message ?? e).slice(0, 120)));
      return { hash: r.hash, explorer: explorerTx(chain, r.hash) };
    } catch (e: any) {
      const msg = redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 200);
      await audit(req.user!.id, "nft.failed", chain.key, transfer.to.toLowerCase(), { ...detail, error: msg });
      throw Object.assign(new Error(`Broadcast failed: ${msg}`), { statusCode: 502 });
    }
  });
}
