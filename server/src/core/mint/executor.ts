// SPDX-License-Identifier: AGPL-3.0-only
import { Contract, ZeroHash, formatEther, toQuantity } from "ethers";
import { explorerTx, requireChain } from "../../config/chains.js";
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
import { getFees, feesMoved, jobFeesIfFresh, rememberJobFees, type Fees } from "./fees.js";
import { sendWhenLive, startStageProbe, SIM_LEAD_MS, type StageProbe } from "./readiness.js";
import { openseaKeyLog } from "../resolver/openseaKeys.js";
import { parseMintedTokenIds, waitForReceipt } from "./receipts.js";
import { fallbackGas } from "./simulate.js";
import { broadcastRejectedMessage, buildFailureMessage, revertedOnChainMessage, signFailureMessage } from "./jobErrors.js";
import { describeTxError } from "../tx/revert.js";
import { MintRequest } from "./types.js";
import { signRawTransaction } from "../../auth/privy.js";
import { log } from "../../util/log.js";
import { BUILD_CONCURRENCY, MintRateLog, OPENSEA_LEAD_MS, probeAndRelease, type ProbeCall } from "./openseaLimit.js";

export { BUILD_CONCURRENCY, NOT_ACTIVE_RETRY_MS, OPENSEA_LEAD_MS, RATE_LIMIT_RETRY_MS, nextRetryDelay } from "./openseaLimit.js";

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
  /** Milliseconds spent in eth_sendRawTransaction. */
  broadcastMs?: number;
}
export interface Prepared {
  walletId: string;
  address: string;
  quantity: number;
  raw: string;
  hash: string;
  reserveRef: string;
  reserveWei: bigint;
  /** eth_call loop for a tx we built ourselves. The T0 send does not wait on it. */
  readiness?: StageProbe;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Max time a gas estimate may add after the start before the fallback/hint gas is used instead. */
export const GAS_ESTIMATE_BUDGET_MS = 400;
/** Simulation gas hint is raised by this much so a slightly heavier live stage still fits. */
export function gasFromHint(hint: bigint): bigint {
  if (hint <= 0n) return 0n;
  return (hint * 130n) / 100n;
}

/** After T0 the OpenSea mint call must not sit on a 10s timeout. */
export const MINT_API_TIMEOUT_MS = 1_500;
/** How long a fresh fee read may delay a signature. The T-60s quote is used if this expires. */
const FEE_REFRESH_BUDGET_MS = 150;
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
  // OpenSea signs after the build that starts at T−150ms. The fresh quote is started then
  // (see below) and may not hold the signature for more than FEE_REFRESH_BUDGET_MS.
  let freshFees: Fees | null = null;
  let feeWatchStarted = 0;
  let feeWatch: Promise<Fees | null> | null = null;
  const feesForSign = async (): Promise<Fees> => {
    if (!feeWatch) return fees;
    if (freshFees) return freshFees;
    const budget = Math.max(0, FEE_REFRESH_BUDGET_MS - (Date.now() - feeWatchStarted));
    if (budget > 0) await Promise.race([feeWatch, sleep(budget)]);
    return freshFees ?? fees;
  };
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
    // After T0 the hot path does not touch the database. A cancel in that window is seen on the next read.
    if (hotAt !== undefined && Date.now() >= hotAt) return lastCheckP;
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
  const hotAt = fireAt !== undefined ? fireAt - OPENSEA_LEAD_MS : undefined;
  const deferredLogs: string[] = [];
  const jobLogHot = async (msg: string) => {
    log.info(`[job ${job.id.slice(0, 8)}] ${msg}`);
    if (hotAt !== undefined && Date.now() >= hotAt) {
      deferredLogs.push(msg);
      return;
    }
    await appendJobLog(job.id, msg);
  };
  const t0 = Date.now();
  const timing = req.wallets.map(() => ({
    build: -1,
    gas: -1,
    sign: -1,
    ready: -1,
    attempts: 0,
    firstAttemptAt: -1,
    path: "post" as "post" | "presigned" | "resigned",
  }));
  const sameTx = (a: BuiltTx, b: BuiltTx) =>
    a.to.toLowerCase() === b.to.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;

  const buildOnce = async (i: number): Promise<BuiltTx> => {
    timing[i].attempts++;
    if (timing[i].firstAttemptAt < 0) timing[i].firstAttemptAt = Date.now();
    return buildMintTx(t, req, results[i].address, req.wallets[i].quantity, undefined, job.userId, {
      mintTimeoutMs: MINT_API_TIMEOUT_MS,
    });
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
      void jobLogHot(`gas estimate ${results[i].address.slice(0, 8)}: ${why?.message ?? "failed"} (using fallback gas)`).catch(() => {});
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

  const sign = async (i: number, tx: BuiltTx, gasLimit: bigint, nonce: number, quote?: Fees) => {
    const w = walletRows[i];
    if (!w.privyWalletId) throw new Error("Wallet has no Privy id — re-sync from Settings/Wallets");
    const use = quote ?? (await feesForSign());
    return signRawTransaction(w.privyWalletId, {
      to: tx.to,
      data: tx.data,
      value: toQuantity(tx.value),
      nonce,
      chainId: chain.chainId,
      gasLimit: toQuantity(gasLimit),
      maxFeePerGas: toQuantity(use.maxFeePerGas),
      maxPriorityFeePerGas: toQuantity(use.maxPriorityFeePerGas),
    });
  };

  // OpenSea is not fanned out before the stage opens. One probe polls; the rest wait for it.
  const pre: ({ tx: BuiltTx; gas: bigint; nonce: number; raw: string } | null)[] = req.wallets.map(() => null);

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
  if (req.strategy === "opensea_api") {
    feeWatchStarted = Date.now();
    feeWatch = getFees(pool, mode)
      .then((f) => {
        freshFees = f;
        return f;
      })
      .catch(() => null);
  }
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
  const stageProbe: (StageProbe | undefined)[] = req.wallets.map(() => undefined);
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
      readiness: stageProbe[i],
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

  const rateLog = new MintRateLog();
  let probeAttempts = 0;
  let releaseAt: number | undefined;
  let waited = 0;

  const classify = (e: unknown): ProbeCall<BuiltTx> => {
    if (e instanceof JobCancelledError) throw e;
    if (e instanceof MintBuildError) {
      const base = {
        error: e,
        retryAfterMs: e.retryAfterMs,
        resetAt: e.rateLimit?.resetAt,
        limit: e.rateLimit?.limit,
        remaining: e.rateLimit?.remaining,
      };
      if (e.code === "NOT_ACTIVE") return { kind: "closed", ...base };
      if (e.code === "RATE_LIMIT") return { kind: "rate", ...base };
      if (e.code === "NOT_ELIGIBLE" || e.code === "INSUFFICIENT_FUNDS") return { kind: "live", ...base };
      if (e.code === "RETRY" || e.code === "HTTP_401" || e.code === "HTTP_403" || /^HTTP_5/.test(e.code))
        return { kind: "promote", ...base };
      return { kind: "fail", ...base };
    }
    return { kind: "fail", error: e };
  };

  const afterBuild = async (i: number, tx: BuiltTx) => {
    const w = walletRows[i];
    built[i] = tx;
    try {
      if (await cancelled()) throw new JobCancelledError();
      const nonce = await freshNonces[i];
      let usedNonce = nonce;
      const pr = pre[i];
      if (pr && sameTx(pr.tx, tx) && pr.nonce === nonce) {
        gasLimits[i] = pr.gas;
        raws[i] = pr.raw;
        timing[i].path = "presigned";
      } else {
        if (pr) timing[i].path = "resigned";
        let s = Date.now();
        gasLimits[i] = await gasFor(tx, i);
        timing[i].gas = Date.now() - s;
        if (streaming && tx.value + gasLimits[i] * fees.maxFeePerGas > upfront[i])
          await assertDailyBudget(job.userId, chain, upfrontTotal - upfront[i] + tx.value + gasLimits[i] * fees.maxFeePerGas);
        s = Date.now();
        raws[i] = await sign(i, tx, gasLimits[i], nonce);
        timing[i].sign = Date.now() - s;
      }
      // Local calldata was signed a few seconds early. Re-read the nonce just before the start and re-sign only if it moved.
      if (req.strategy !== "opensea_api" && fireAt && Date.now() < fireAt - NONCE_REFRESH_LEAD_MS) {
        await waitUntil(fireAt - NONCE_REFRESH_LEAD_MS, cancelled);
        const nowNonce = await pool.read((p) => p.getTransactionCount(results[i].address, "pending"), "nonce").catch(() => nonce);
        if (nowNonce !== nonce) {
          raws[i] = await sign(i, tx, gasLimits[i], nowNonce);
          usedNonce = nowNonce;
          timing[i].path = "resigned";
          void jobLogHot(`nonce changed for ${results[i].address.slice(0, 8)}, re-signed`).catch(() => {});
        }
      }
      // Pre-signed paths: at about T−1s, re-quote fees and re-sign the same nonce if they moved more than 10%.
      // The broadcast gate is still T0, so an on-time send is not held for this.
      if (req.strategy !== "opensea_api" && fireAt && raws[i]) {
        stageProbe[i] = startStageProbe({
          fireAt,
          deadline: buildDeadline,
          call: async () => {
            await pool.read((p) => p.call({ to: tx.to, data: tx.data, value: tx.value, from: results[i].address }), "simMint");
          },
        });
        const refreshAt = fireAt - SIM_LEAD_MS;
        if (Date.now() < refreshAt) await waitUntil(refreshAt, cancelled);
        if (Date.now() < fireAt) {
          const budget = Math.min(FEE_REFRESH_BUDGET_MS, Math.max(0, fireAt - Date.now()));
          const next = await Promise.race([getFees(pool, mode).catch(() => null), sleep(budget).then(() => null)]);
          if (next && feesMoved(fees.maxFeePerGas, next.maxFeePerGas)) {
            raws[i] = await sign(i, tx, gasLimits[i], usedNonce, next);
            timing[i].path = "resigned";
          }
        }
      }
    } catch (e: any) {
      results[i].status = "failed";
      results[i].error =
        e instanceof JobCancelledError
          ? "Cancelled before signing"
          : await signFailureMessage(e, w.address, { chain, contract: req.contract });
      if (e instanceof JobCancelledError) throw e;
      return;
    }
    if (streaming && raws[i]) await finish(i);
  };

  // Per-wallet pipeline: build → gas → sign → (stream) send. A low balance is not a reason to skip.
  if (req.strategy === "opensea_api") {
    const report = await probeAndRelease<BuiltTx>({
      count: req.wallets.length,
      fireAt,
      deadline: buildDeadline,
      isolateRateLimits: true,
      maxConcurrency: BUILD_CONCURRENCY,
      tick: async () => {
        if (await cancelled()) throw new JobCancelledError();
      },
      call: async (i) => {
        const s = Date.now();
        timing[i].attempts++;
        if (timing[i].firstAttemptAt < 0) timing[i].firstAttemptAt = Date.now();
        try {
          const tx = await buildMintTx(t, req, results[i].address, req.wallets[i].quantity, undefined, job.userId, {
            mintTimeoutMs: MINT_API_TIMEOUT_MS,
            mintJobId: job.id,
            walletIndex: i,
            onMintSample: (sample) => rateLog.note(sample),
          });
          timing[i].build = Date.now() - s;
          return { kind: "ok", value: tx };
        } catch (e) {
          return classify(e);
        }
      },
      onOk: (i, tx) => afterBuild(i, tx),
      onFail: async (i, error) => {
        if (results[i].status === "failed") return;
        results[i].status = "failed";
        results[i].error = await buildFailureMessage(error, { chain, contract: req.contract });
      },
    });
    probeAttempts = report.probeAttempts;
    releaseAt = report.releaseAt;
    waited = report.released;
  } else {
    await mapLimit(req.wallets, BUILD_CONCURRENCY, async (_w, i) => {
      let tx: BuiltTx;
      try {
        const s = Date.now();
        tx = await buildOnce(i);
        timing[i].build = Date.now() - s;
      } catch (e: any) {
        if (e instanceof JobCancelledError) throw e;
        results[i].status = "failed";
        results[i].error = await buildFailureMessage(e, { chain, contract: req.contract });
        return;
      }
      await afterBuild(i, tx);
    });
  }

  const reserve = built.map((tx, i) => (tx ? tx.value + gasLimits[i] * fees.maxFeePerGas : 0n));
  const total = reserve.reduce((a, b) => a + b, 0n);
  if (!streaming) {
    // Barrier mode (price unknown up front): budget check on the real total before anything is released.
    await assertDailyBudget(job.userId, chain, total);
    await Promise.all(raws.map((raw, i) => (raw ? finish(i) : Promise.resolve())));
  }
  const ms = (k: "build" | "gas" | "sign" | "ready") => {
    const v = timing.map((x) => x[k]).filter((x) => x >= 0);
    return v.length ? `${Math.min(...v)}–${Math.max(...v)}ms` : "-";
  };
  const off = (at: number) => (fireAt === undefined || at < 0 ? "?" : `${at - fireAt >= 0 ? "+" : ""}${at - fireAt}ms`);
  const perWallet = timing
    .map((x, i) => {
      const addr = results[i].address.slice(0, 8);
      return `${addr} first ${off(x.firstAttemptAt)} attempts ${x.attempts} build ${x.build}ms sign ${x.sign}ms ready ${x.ready < 0 ? "?" : `${x.ready}ms`}`;
    })
    .join(" | ");
  deferredLogs.push(
    `prepared ${prepared.length}/${req.wallets.length} txs (maxFee ${Number(fees.maxFeePerGas) / 1e9} gwei, worst-case total ${formatEther(total)} ${chain.nativeSymbol}) · build ${ms("build")}, gas ${ms("gas")}, sign ${ms("sign")}, ready ${ms("ready")}, presigned ${timing.filter((x) => x.path === "presigned").length}, setup ${tStart - t0}ms, mode ${streaming ? "stream" : "batch"} · probe ${probeAttempts} release ${off(releaseAt ?? -1)} waited ${waited}${rateLog.seen ? ` · ${rateLog.format()}` : ""}${req.strategy === "opensea_api" && openseaKeyLog() ? ` · ${openseaKeyLog()}` : ""} · ${perWallet}`,
  );
  log.info(`[job ${job.id.slice(0, 8)}] ${deferredLogs[deferredLogs.length - 1]}`);
  if (deferredLogs.length) void appendJobLog(job.id, deferredLogs.join(" · ")).catch(() => {});
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
          const sentAt = Date.now();
          const sent = await sendWhenLive(async () => {
            const attempt = await pool.broadcast(p.raw);
            return { ok: attempt.accepted.length > 0, errors: attempt.errors.map((e) => e.error), attempt };
          }, p.readiness);
          const b = sent.attempt;
          r.broadcastMs = Date.now() - sentAt;
          r.txHash = b.hash;
          r.explorer = explorerTx(chain, b.hash);
          r.acceptedBy = b.accepted.length;
          if (!b.accepted.length) {
            r.status = "failed";
            r.error = broadcastRejectedMessage(
              b.errors.map((e) => e.error),
              chain.nativeSymbol,
            );
            return;
          }
          // Budget write stays off the send. The node has already accepted the tx.
          await recordSpend(job.userId, chain, p.reserveWei, p.reserveRef).catch((e: any) => {
            log.warn(`recordSpend ${p.reserveRef}`, String(e?.message ?? e).slice(0, 160));
          });
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
    const sent = results.filter((r) => r.broadcastMs !== undefined);
    if (sent.length)
      log.info(`[job ${job.id.slice(0, 8)}] broadcast ms ${sent.map((r) => `${r.address.slice(0, 8)} ${r.broadcastMs}ms`).join(", ")}`);
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
