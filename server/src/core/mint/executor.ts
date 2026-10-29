// SPDX-License-Identifier: AGPL-3.0-only
import { formatEther, toQuantity } from "ethers";
import { explorerTx, requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { getResolved } from "../resolver/cache.js";
import { getWallet } from "../../users/service.js";
import { assertDailyBudget, recordSpend, settleSpend } from "../safety/safety.js";
import { appendJobLog, patchJob, recordMinted, type JobRecord } from "../jobs/repo.js";
import { buildMintTx, MintBuildError } from "./build.js";
import { getFees } from "./fees.js";
import { parseMintedTokenIds, waitForReceipt } from "./receipts.js";
import { fallbackGas } from "./simulate.js";
import { broadcastRejectedMessage, buildFailureMessage, revertedOnChainMessage, signFailureMessage } from "./jobErrors.js";
import { describeTxError } from "../tx/revert.js";
import { MintRequest } from "./types.js";
import { signRawTransaction } from "../../auth/privy.js";
import { log } from "../../util/log.js";

export interface WalletResult {
  walletId: string;
  address: string;
  quantity: number;
  status: "pending" | "signed" | "broadcast" | "confirmed" | "reverted" | "failed" | "timeout";
  txHash?: string;
  explorer?: string;
  tokenIds?: string[];
  gasUsed?: string;
  costWei?: string;
  error?: string;
  acceptedBy?: number;
}
interface Prepared {
  walletId: string;
  address: string;
  quantity: number;
  raw: string;
  hash: string;
  reserveRef: string;
  reserveWei: bigint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jobLog(job: JobRecord, msg: string) {
  await appendJobLog(job.id, msg);
  log.info(`[job ${job.id.slice(0, 8)}] ${msg}`);
}
async function setResults(job: JobRecord, results: WalletResult[]) {
  await patchJob(job.id, { results });
}

/**
 * Prepare (build + nonce + fees + sign via Privy) all wallet txs.
 * Signing uses Privy's wallet API with the app authorization key — we never hold private keys.
 */
export async function prepareAll(
  job: JobRecord,
  req: MintRequest,
  gasHints: Record<string, string>,
  buildDeadline: number,
): Promise<{ prepared: Prepared[]; results: WalletResult[] }> {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  await pool.checkChainId();
  const t = await getResolved(chain.key, req.contract, req.input);
  const fees = await getFees(pool, req.gasMode);
  const walletRows = await Promise.all(req.wallets.map((w) => getWallet(job.userId, w.walletId)));
  const results: WalletResult[] = req.wallets.map((w, i) => ({
    walletId: w.walletId,
    address: walletRows[i].address,
    quantity: w.quantity,
    status: "pending",
  }));

  const built = await Promise.all(
    req.wallets.map(async (wq, i) => {
      const addr = results[i].address;
      for (;;) {
        try {
          return await buildMintTx(t, req, addr, wq.quantity);
        } catch (e: any) {
          if (e instanceof MintBuildError && e.code === "NOT_ACTIVE" && Date.now() < buildDeadline) {
            await sleep(300);
            continue;
          }
          results[i].status = "failed";
          results[i].error = await buildFailureMessage(e, { chain, contract: req.contract });
          return null;
        }
      }
    }),
  );

  const gasLimits = await Promise.all(
    built.map(async (tx, i) => {
      if (!tx) return 0n;
      if (req.gasLimit) return BigInt(req.gasLimit);
      try {
        const g = await pool.read(
          (p) => p.estimateGas({ from: results[i].address, to: tx.to, data: tx.data, value: tx.value }),
          "estimateGas",
        );
        return (g * 125n) / 100n;
      } catch (e: any) {
        // Expected before a stage opens (pre-signing); still sent with the hint gas, but the reason is kept in the log.
        const why = await describeTxError(e, { chain, contracts: [req.contract] }).catch(() => null);
        await jobLog(job, `gas estimate ${results[i].address.slice(0, 8)}: ${why?.message ?? "failed"} (using fallback gas)`).catch(
          () => {},
        );
        return BigInt(gasHints[req.wallets[i].walletId] ?? fallbackGas(req.strategy, req.wallets[i].quantity));
      }
    }),
  );

  const reserve = built.map((tx, i) => (tx ? tx.value + gasLimits[i] * fees.maxFeePerGas : 0n));
  const total = reserve.reduce((a, b) => a + b, 0n);
  await assertDailyBudget(job.userId, chain, total);

  const prepared: Prepared[] = [];
  await Promise.all(
    built.map(async (tx, i) => {
      if (!tx) return;
      const wq = req.wallets[i];
      const w = walletRows[i];
      try {
        if (!w.privyWalletId) throw new Error("Wallet has no Privy id — re-sync from Settings/Wallets");
        const nonce = await pool.read((p) => p.getTransactionCount(w.address, "pending"), "nonce");
        const raw = await signRawTransaction(w.privyWalletId, {
          to: tx.to,
          data: tx.data,
          value: toQuantity(tx.value),
          nonce,
          chainId: chain.chainId,
          gasLimit: toQuantity(gasLimits[i]),
          maxFeePerGas: toQuantity(fees.maxFeePerGas),
          maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas),
        });
        const ref = `${job.id}:${wq.walletId}`;
        prepared.push({
          walletId: wq.walletId,
          address: w.address,
          quantity: wq.quantity,
          raw,
          hash: "",
          reserveRef: ref,
          reserveWei: reserve[i],
        });
        results[i].status = "signed";
      } catch (e: any) {
        results[i].status = "failed";
        results[i].error = await signFailureMessage(e, w.address, { chain, contract: req.contract });
      }
    }),
  );
  await jobLog(
    job,
    `prepared ${prepared.length}/${req.wallets.length} txs (maxFee ${Number(fees.maxFeePerGas) / 1e9} gwei, worst-case total ${formatEther(total)} ${chain.nativeSymbol})`,
  );
  return { prepared, results };
}

export async function broadcastAndTrack(
  job: JobRecord,
  req: MintRequest,
  prepared: Prepared[],
  results: WalletResult[],
  receiptTimeoutMs = 180_000,
) {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  // Per-wallet isolation: one spend/broadcast failure must not drop other wallets' tx hashes.
  try {
    await Promise.all(
      prepared.map(async (p) => {
        const r = results.find((x) => x.walletId === p.walletId)!;
        try {
          try {
            await recordSpend(job.userId, chain, p.reserveWei, p.reserveRef);
          } catch (e: any) {
            // Budget row is best-effort; never block the send on a DB blip (hash must still be recorded).
            log.warn(`recordSpend ${p.reserveRef}`, String(e?.message ?? e).slice(0, 160));
          }
          const b = await pool.broadcast(p.raw);
          r.txHash = b.hash;
          r.explorer = explorerTx(chain, b.hash);
          r.acceptedBy = b.accepted.length;
          if (!b.accepted.length) {
            r.status = "failed";
            r.error = broadcastRejectedMessage(
              b.errors.map((e) => e.error),
              chain.nativeSymbol,
            );
            await settleSpend(p.reserveRef, 0n).catch(() => {});
            return;
          }
          r.status = "broadcast";
        } catch (e: any) {
          if (r.txHash) {
            if (r.status !== "broadcast") r.status = "broadcast";
            r.error = `Broadcasted but follow-up failed: ${String(e?.message ?? e).slice(0, 160)}`;
            log.warn(`post-broadcast ${p.walletId}`, String(e?.message ?? e).slice(0, 160));
          } else {
            r.status = "failed";
            r.error = broadcastRejectedMessage([String(e?.message ?? e)], chain.nativeSymbol);
          }
        }
      }),
    );
  } finally {
    await setResults(job, results);
  }
  await jobLog(job, `broadcast ${results.filter((r) => r.status === "broadcast").length} txs`);

  await trackReceipts(job, req, results, receiptTimeoutMs);
}

/**
 * Wait for receipts of "broadcast" results (bounded). Results still pending when time runs out stay
 * "broadcast" so housekeeping can finish them later (serverless functions have a hard max duration).
 */
export async function trackReceipts(job: JobRecord, req: MintRequest, results: WalletResult[], timeoutMs = 180_000, finalAttempt = true) {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  await Promise.all(
    results
      .filter((r) => r.status === "broadcast")
      .map(async (r) => {
        const rec = await waitForReceipt(pool, r.txHash!, Math.max(0, timeoutMs));
        const ref = `${job.id}:${r.walletId}`;
        if (!rec) {
          if (finalAttempt) {
            r.status = "timeout";
            r.error = "no receipt in time (may still confirm)";
          }
          return;
        }
        const cost = rec.gasUsed * (rec.gasPrice ?? 0n);
        r.gasUsed = rec.gasUsed.toString();
        if (rec.status === 1) {
          r.status = "confirmed";
          r.tokenIds = parseMintedTokenIds(rec.logs, req.contract, r.address);
          const value = BigInt((await pool.read((p) => p.getTransaction(r.txHash!), "getTx").catch(() => null))?.value ?? 0n);
          r.costWei = (value + cost).toString();
          await settleSpend(ref, value + cost);
          await recordMinted(job.userId, {
            chain: chain.key,
            contract: req.contract,
            wallet: r.address,
            tokenIds: r.tokenIds!,
            txHash: r.txHash!,
          });
        } else {
          r.status = "reverted";
          r.costWei = cost.toString();
          // Why: replay the same call at its block (eth_call, read-only) through the shared revert decoder.
          const tx: any = await pool.read((p) => p.getTransaction(r.txHash!), "getTx").catch(() => null);
          r.error = tx
            ? await revertedOnChainMessage(
                (blockTag) => pool.read((p) => p.call({ from: r.address, to: tx.to, data: tx.data, value: tx.value, blockTag }), "replay"),
                rec.blockNumber,
                rec.gasUsed,
                tx.gasLimit ?? null,
                { chain, contract: req.contract },
              ).catch(() => "Reverted on-chain.")
            : "Reverted on-chain.";
          await settleSpend(ref, cost);
        }
      }),
  );
  await setResults(job, results);
  await jobLog(
    job,
    `done: ${results.filter((r) => r.status === "confirmed").length} confirmed, ${results.filter((r) => r.status === "reverted").length} reverted, ${results.filter((r) => r.status === "failed" || r.status === "timeout").length} failed`,
  );
}
