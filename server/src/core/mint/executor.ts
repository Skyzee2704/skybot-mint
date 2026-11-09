// SPDX-License-Identifier: AGPL-3.0-only
import { Contract, ZeroHash, formatEther, toQuantity } from "ethers";
import { explorerTx, requireChain } from "../../config/chains.js";
import { nativeText } from "../../util/native.js";
import { getPool } from "../rpc/pool.js";
import { getResolved } from "../resolver/cache.js";
import { SEADROP_ABI, SEADROP_ADDRESS } from "../resolver/seadrop.js";
import { getMerkleInfo } from "./access.js";
import { getWallet } from "../../users/service.js";
import { assertDailyBudget, recordSpend, settleSpend } from "../safety/safety.js";
import { appendJobLog, jobStatus, JobCancelledError, patchJob, recordMinted, type JobRecord } from "../jobs/repo.js";
import { buildMintTx, MintBuildError } from "./build.js";
import { stagePriceWei } from "./stage.js";
import type { BuiltTx } from "./types.js";
import { getFees, jobFeesIfFresh, rememberJobFees } from "./fees.js";
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
export interface Prepared {
  walletId: string;
  address: string;
  quantity: number;
  raw: string;
  hash: string;
  reserveRef: string;
  reserveWei: bigint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stage-not-open retry interval for the mint build (OpenSea 409 / NOT_ACTIVE). */
export const NOT_ACTIVE_RETRY_MS = 300;
/** Max time a gas estimate may add after the start before the fallback/hint gas is used instead. */
export const GAS_ESTIMATE_BUDGET_MS = 400;
/** Parallel build/sign per job (keeps OpenSea and Privy below their burst limits). */
export const BUILD_CONCURRENCY = 8;
/** Simulation gas hint is raised by this much so a slightly heavier live stage still fits. */
export function gasFromHint(hint: bigint): bigint {
  if (hint <= 0n) return 0n;
  return (hint * 130n) / 100n;
}

/** After T0 the OpenSea mint call must not sit on a 10s timeout. */
export const MINT_API_TIMEOUT_MS = 1_500;
/** How long before the start we re-read nonces for an already signed local transaction. */
const NONCE_REFRESH_LEAD_MS = 1_200;
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Run `fn` over items with at most `limit` in flight; rejects with the first thrown error. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Delay before the next build retry. Retries are aligned so one attempt lands exactly at `fireAt` instead of up to
 * one interval after it (pure, unit-tested).
 */
export function nextRetryDelay(now: number, fireAt: number | undefined, interval = NOT_ACTIVE_RETRY_MS): number {
  if (fireAt !== undefined && now < fireAt && fireAt < now + interval) return fireAt - now;
  return interval;
}

/** Wait until `at` (coarse sleep, then a short spin for the last ms). `check` runs about once a second. */
export async function waitUntil(at: number, check?: () => Promise<boolean>) {
  let last = Date.now();
  while (Date.now() < at - 30) {
    await sleep(Math.min(100, at - 30 - Date.now()));
    if (check && Date.now() - last >= 1000) {
      last = Date.now();
      if (await check()) throw new JobCancelledError();
    }
  }
  while (Date.now() < at) {
    /* spin ≤30ms */
  }
}

async function jobLog(job: JobRecord, msg: string) {
  await appendJobLog(job.id, msg);
  log.info(`[job ${job.id.slice(0, 8)}] ${msg}`);
}
async function setResults(job: JobRecord, results: WalletResult[]) {
  await patchJob(job.id, { results });
}

/**
 * Drop, fees, and a readable merkle list. Called when the scheduled function wakes (~T−60s), so the last
 * few seconds are only nonce, sign, and broadcast. Failures are the caller's to log; prepareAll retries.
 */
export async function warmMint(req: MintRequest): Promise<void> {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  const mode = req.gasMode ?? "normal";
  const [t, fees] = await Promise.all([getResolved(chain.key, req.contract, req.input), getFees(pool, mode)]);
  rememberJobFees(chain.key, mode, fees);
  if (t.kind !== "seadrop" || !t.seadrop?.hasAllowList) return;
  const root = await pool.read(
    (p) => new Contract(SEADROP_ADDRESS, SEADROP_ABI, p).getAllowListMerkleRoot(t.contract) as Promise<string>,
    "merkleRoot",
  );
  if (root && root !== ZeroHash) await getMerkleInfo(chain, t.contract, root);
}

/**
 * Prepare (build + nonce + fees + sign via Privy) all wallet txs.
 * Signing uses Privy's wallet API with the app authorization key — we never hold private keys.
 *
 * Latency: everything that does not depend on the stage being open (chain id, resolved target, fees, wallet rows,
 * nonces) is fetched up front and in parallel. With `buildNotBefore` (OpenSea mint API, which only builds once the
 * stage is open), the first build call is held until that instant, so only build → gas → sign remain after the start.
 */
export async function prepareAll(
  job: JobRecord,
  req: MintRequest,
  gasHints: Record<string, string>,
  buildDeadline: number,
  opts: { buildNotBefore?: number; fireAt?: number; onSigned?: (p: Prepared, results: WalletResult[]) => Promise<void> } = {},
): Promise<{ prepared: Prepared[]; results: WalletResult[] }> {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  const mode = req.gasMode ?? "normal";
  const [, t, walletRows] = await Promise.all([
    pool.checkChainId(),
    getResolved(chain.key, req.contract, req.input),
    Promise.all(req.wallets.map((w) => getWallet(job.userId, w.walletId))),
  ]);
  // Fees were read at wake when the job was scheduled ahead. A mint-now job, or a missed warm-up, reads them here.
  const fees = jobFeesIfFresh(chain.key, mode) ?? (await getFees(pool, mode));
  // Nonces don't depend on the build: fetch now (in parallel) so signing doesn't wait on another RPC round trip.
  const nonces = walletRows.map((w) => pool.read((p) => p.getTransactionCount(w.address, "pending"), "nonce"));
  nonces.forEach((n) => n.catch(() => {}));
  const results: WalletResult[] = req.wallets.map((w, i) => ({
    walletId: w.walletId,
    address: walletRows[i].address,
    quantity: w.quantity,
    status: "pending",
  }));

  // Shared, throttled cancel check (≤1 DB read/second for all wallets) used while waiting for the stage to open.
  let lastCheck = 0;
  let lastCheckP: Promise<boolean> = Promise.resolve(false);
  const cancelled = () => {
    if (Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now();
      lastCheckP = jobStatus(job.id).then(
        (s) => s === "cancelled",
        () => false,
      );
    }
    return lastCheckP;
  };

  const fireAt = opts.fireAt ?? opts.buildNotBefore;
  const t0 = Date.now();
  const timing = req.wallets.map(() => ({ build: -1, gas: -1, sign: -1, ready: -1, path: "post" as "post" | "presigned" | "resigned" }));
  const sameTx = (a: BuiltTx, b: BuiltTx) =>
    a.to.toLowerCase() === b.to.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;

  const buildWithRetry = async (i: number): Promise<BuiltTx> => {
    for (;;) {
      try {
        return await buildMintTx(t, req, results[i].address, req.wallets[i].quantity, undefined, job.userId, {
          mintTimeoutMs: MINT_API_TIMEOUT_MS,
        });
      } catch (e: any) {
        if (e instanceof MintBuildError && (e.code === "NOT_ACTIVE" || e.code === "RETRY") && Date.now() < buildDeadline) {
          await sleep(e.code === "NOT_ACTIVE" ? nextRetryDelay(Date.now(), fireAt) : 50);
          if (await cancelled()) throw new JobCancelledError();
          continue;
        }
        throw e;
      }
    }
  };

  const hintOf = (i: number): bigint => {
    const raw = gasHints[req.wallets[i].walletId];
    return raw && /^\d+$/.test(String(raw)) ? BigInt(raw) : 0n;
  };
  const bufferedHint = (i: number) => gasFromHint(hintOf(i));
  const fallbackBuffered = (i: number) => (fallbackGas(req.strategy, req.wallets[i].quantity) * 130n) / 100n;
  /** Full estimate before T0. After T0 this is only the no-hint OpenSea fallback, and it is raced against 400ms. */
  const estimateGas = async (tx: BuiltTx, i: number): Promise<bigint> => {
    const fb = maxBig(bufferedHint(i), fallbackBuffered(i));
    try {
      const g = await pool.read(
        (p) => p.estimateGas({ from: results[i].address, to: tx.to, data: tx.data, value: tx.value }),
        "estimateGas",
      );
      return (g * 125n) / 100n;
    } catch (e: any) {
      const why = await describeTxError(e, { chain, contracts: [req.contract] }).catch(() => null);
      void jobLog(job, `gas estimate ${results[i].address.slice(0, 8)}: ${why?.message ?? "failed"} (using fallback gas)`).catch(() => {});
      return fb;
    }
  };
  const gasFor = async (tx: BuiltTx, i: number): Promise<bigint> => {
    if (req.gasLimit) return BigInt(req.gasLimit);
    const hint = bufferedHint(i);
    const afterStart = fireAt !== undefined && Date.now() >= fireAt;
    if (req.strategy !== "opensea_api") {
      if (hint) return hint;
      if (afterStart) return fallbackBuffered(i);
      return estimateGas(tx, i);
    }
    if (hint) return hint;
    if (!afterStart) return estimateGas(tx, i);
    const fb = maxBig(hint, fallbackBuffered(i));
    return Promise.race([estimateGas(tx, i), sleep(GAS_ESTIMATE_BUDGET_MS).then(() => fb)]);
  };

  const sign = async (i: number, tx: BuiltTx, gasLimit: bigint, nonce: number) => {
    const w = walletRows[i];
    if (!w.privyWalletId) throw new Error("Wallet has no Privy id — re-sync from Settings/Wallets");
    return signRawTransaction(w.privyWalletId, {
      to: tx.to,
      data: tx.data,
      value: toQuantity(tx.value),
      nonce,
      chainId: chain.chainId,
      gasLimit: toQuantity(gasLimit),
      maxFeePerGas: toQuantity(fees.maxFeePerGas),
      maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas),
    });
  };

  // Speculative pre-build + pre-sign (OpenSea API only, before the start). OpenSea normally answers 409 until the stage
  // opens, so this usually yields nothing; when it does build (stage already open / a previous stage), the signed tx is
  // only used if OpenSea's build right after the start returns the identical to/data/value (and the nonce is unchanged).
  const pre: ({ tx: BuiltTx; gas: bigint; nonce: number; raw: string } | null)[] = req.wallets.map(() => null);
  if (opts.buildNotBefore !== undefined && Date.now() < opts.buildNotBefore - 500) {
    await mapLimit(req.wallets, BUILD_CONCURRENCY, async (_w, i) => {
      try {
        const tx = await buildMintTx(t, req, results[i].address, req.wallets[i].quantity, undefined, job.userId, {
          mintTimeoutMs: MINT_API_TIMEOUT_MS,
        });
        const gas = await gasFor(tx, i);
        const nonce = await nonces[i];
        pre[i] = { tx, gas, nonce, raw: await sign(i, tx, gas, nonce) };
      } catch {
        /* 409 before the stage opens is expected; the normal path below handles it */
      }
    });
    const n = pre.filter(Boolean).length;
    void jobLog(job, `pre-build: ${n}/${req.wallets.length} pre-signed before start (+${Date.now() - t0}ms)`).catch(() => {});
  }

  // Worst-case budget up front when the price is known, so wallets can be signed and sent one by one (no barrier).
  const priceWei = stagePriceWei(t, req.strategy);
  const capGas = (i: number) =>
    req.gasLimit
      ? BigInt(req.gasLimit)
      : maxBig(BigInt(gasHints[req.wallets[i].walletId] ?? 0), fallbackGas(req.strategy, req.wallets[i].quantity)) * 2n;
  const upfront = req.wallets.map((w, i) => (priceWei === null ? 0n : priceWei * BigInt(w.quantity) + capGas(i) * fees.maxFeePerGas));
  const upfrontTotal = upfront.reduce((a, b) => a + b, 0n);
  const streaming = priceWei !== null && Boolean(opts.onSigned);
  if (streaming) await assertDailyBudget(job.userId, chain, upfrontTotal);

  if (opts.buildNotBefore !== undefined) await waitUntil(opts.buildNotBefore, cancelled);
  const tStart = Date.now();
  // Nonce refresh: re-read pending nonces in parallel with the build (cheap; catches a tx sent since pre-fetch).
  const freshNonces = walletRows.map((w, i) =>
    opts.buildNotBefore !== undefined
      ? pool.read((p) => p.getTransactionCount(w.address, "pending"), "nonce").catch(() => nonces[i])
      : nonces[i],
  );

  const built: (BuiltTx | null)[] = req.wallets.map(() => null);
  const gasLimits: bigint[] = req.wallets.map(() => 0n);
  const raws: (string | null)[] = req.wallets.map(() => null);
  const prepared: Prepared[] = [];
  let streamErr: unknown = null;

  const finish = async (i: number) => {
    const wq = req.wallets[i];
    const p: Prepared = {
      walletId: wq.walletId,
      address: walletRows[i].address,
      quantity: wq.quantity,
      raw: raws[i]!,
      hash: "",
      reserveRef: `${job.id}:${wq.walletId}`,
      reserveWei: built[i]!.value + gasLimits[i] * fees.maxFeePerGas,
    };
    prepared.push(p);
    results[i].status = "signed";
    timing[i].ready = Date.now() - tStart;
    if (streaming) {
      try {
        await opts.onSigned!(p, results);
      } catch (e) {
        streamErr ??= e;
      }
    }
  };

  const chosenPrice = (): bigint | null => {
    const stage = req.stage ? t.stages.find((s) => s.name === req.stage) : null;
    if (stage?.priceWei != null) return BigInt(stage.priceWei);
    return stagePriceWei(t, req.strategy);
  };
  /** True when this wallet cannot cover price + gas. Leaves a clear skip on the result and does not sign. */
  const skipForBalance = async (i: number, value: bigint, gas: bigint): Promise<boolean> => {
    const bal = await pool.read((p) => p.getBalance(results[i].address), "balance").catch(() => null);
    if (bal === null) return false;
    const need = value + gas * fees.maxFeePerGas;
    if (bal >= need) return false;
    results[i].status = "failed";
    results[i].error =
      `Not enough balance (have ${nativeText(bal, chain.nativeSymbol)}, need ~${nativeText(need, chain.nativeSymbol)}). Skipped.`;
    void jobLog(
      job,
      `skip ${results[i].address.slice(0, 8)}: balance ${nativeText(bal, chain.nativeSymbol)} < ~${nativeText(need, chain.nativeSymbol)}`,
    ).catch(() => {});
    return true;
  };

  // Per-wallet pipeline (bounded concurrency): build → gas → sign → (stream) send. One slow wallet never holds the rest.
  await mapLimit(req.wallets, BUILD_CONCURRENCY, async (_w, i) => {
    const w = walletRows[i];
    const quoted = chosenPrice();
    if (req.strategy === "opensea_api" && quoted !== null) {
      const guess = bufferedHint(i) || fallbackBuffered(i);
      if (await skipForBalance(i, quoted * BigInt(req.wallets[i].quantity), guess)) return;
    }
    let s = Date.now();
    let tx: BuiltTx;
    try {
      tx = await buildWithRetry(i);
      timing[i].build = Date.now() - s;
    } catch (e: any) {
      if (e instanceof JobCancelledError) throw e;
      results[i].status = "failed";
      results[i].error = await buildFailureMessage(e, { chain, contract: req.contract });
      return;
    }
    built[i] = tx;
    try {
      if (await cancelled()) throw new JobCancelledError();
      const nonce = await freshNonces[i];
      const pr = pre[i];
      if (pr && sameTx(pr.tx, tx) && pr.nonce === nonce) {
        gasLimits[i] = pr.gas;
        raws[i] = pr.raw;
        timing[i].path = "presigned";
      } else {
        if (pr) timing[i].path = "resigned";
        s = Date.now();
        gasLimits[i] = await gasFor(tx, i);
        timing[i].gas = Date.now() - s;
        if (streaming && tx.value + gasLimits[i] * fees.maxFeePerGas > upfront[i])
          await assertDailyBudget(job.userId, chain, upfrontTotal - upfront[i] + tx.value + gasLimits[i] * fees.maxFeePerGas);
        s = Date.now();
        raws[i] = await sign(i, tx, gasLimits[i], nonce);
        timing[i].sign = Date.now() - s;
      }
      if (await skipForBalance(i, tx.value, gasLimits[i])) {
        raws[i] = null;
        return;
      }
      // Local calldata was signed a few seconds early. Re-read the nonce just before the start and re-sign only if it moved.
      if (req.strategy !== "opensea_api" && fireAt && Date.now() < fireAt - NONCE_REFRESH_LEAD_MS) {
        await waitUntil(fireAt - NONCE_REFRESH_LEAD_MS, cancelled);
        const nowNonce = await pool.read((p) => p.getTransactionCount(results[i].address, "pending"), "nonce").catch(() => nonce);
        if (nowNonce !== nonce) {
          raws[i] = await sign(i, tx, gasLimits[i], nowNonce);
          timing[i].path = "resigned";
          void jobLog(job, `nonce changed for ${results[i].address.slice(0, 8)}, re-signed`).catch(() => {});
        }
      }
    } catch (e: any) {
      results[i].status = "failed";
      results[i].error =
        e instanceof JobCancelledError
          ? "Cancelled before signing"
          : await signFailureMessage(e, w.address, { chain, contract: req.contract });
      return;
    }
    if (streaming && raws[i]) await finish(i);
  });

  const reserve = built.map((tx, i) => (tx ? tx.value + gasLimits[i] * fees.maxFeePerGas : 0n));
  const total = reserve.reduce((a, b) => a + b, 0n);
  if (!streaming) {
    // Barrier mode (price unknown up front): budget check on the real total before anything is released.
    await assertDailyBudget(job.userId, chain, total);
    for (let i = 0; i < raws.length; i++) if (raws[i]) await finish(i);
  }
  const ms = (k: "build" | "gas" | "sign" | "ready") => {
    const v = timing.map((x) => x[k]).filter((x) => x >= 0);
    return v.length ? `${Math.min(...v)}–${Math.max(...v)}ms` : "-";
  };
  await jobLog(
    job,
    `prepared ${prepared.length}/${req.wallets.length} txs (maxFee ${Number(fees.maxFeePerGas) / 1e9} gwei, worst-case total ${formatEther(total)} ${chain.nativeSymbol}) · timing after start: build ${ms("build")}, gas ${ms("gas")}, sign ${ms("sign")}, ready ${ms("ready")}, presigned ${timing.filter((x) => x.path === "presigned").length}, setup ${tStart - t0}ms, mode ${streaming ? "stream" : "batch"}`,
  ).catch(() => {});
  if (streamErr) throw streamErr;
  return { prepared, results };
}

export async function broadcastAndTrack(
  job: JobRecord,
  req: MintRequest,
  prepared: Prepared[],
  results: WalletResult[],
  receiptTimeoutMs = 180_000,
  opts: { track?: boolean } = {},
) {
  const chain = requireChain(req.chain);
  const pool = getPool(chain);
  // Per-wallet isolation: one spend/broadcast failure must not drop other wallets' tx hashes.
  try {
    await Promise.all(
      prepared.map(async (p) => {
        const r = results.find((x) => x.walletId === p.walletId)!;
        try {
          // Budget row is best-effort and written in parallel with the send, so the DB round trip never delays it.
          const spend = recordSpend(job.userId, chain, p.reserveWei, p.reserveRef).catch((e: any) => {
            log.warn(`recordSpend ${p.reserveRef}`, String(e?.message ?? e).slice(0, 160));
          });
          const b = await pool.broadcast(p.raw);
          await spend;
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
  if (opts.track === false) return;
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
