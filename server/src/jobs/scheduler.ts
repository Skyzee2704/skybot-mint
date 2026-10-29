// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Job scheduling + execution, serverless-friendly.
 *
 * Vercel: enqueue publishes a QStash message (deduplicationId = jobId) to POST /api/jobs/run with
 * notBefore = runAt − JOB_LEAD_MS. The run route verifies the QStash signature, atomically claims the job
 * (scheduled → running; replays are no-ops), pre-signs via the Privy session signer, sleeps until the exact
 * runAt + offset, then broadcasts to every RPC. Receipts are tracked within the remaining budget; anything
 * still pending is finished by housekeeping (QStash cron → /api/cron/housekeeping).
 *
 * Local dev: no QStash → `startLocalScheduler()` polls the DB and runs due jobs in-process.
 */
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobs, telegramLinks } from "../db/schema.js";
import { env, privyServerSigningReady } from "../config/env.js";
import {
  getJob,
  insertJob,
  listActiveJobs,
  patchJob,
  patchRunningJob,
  patchJobIfStatus,
  appendJobLog,
  beginBroadcast,
  jobStatus,
  JobCancelledError,
  type JobRecord,
} from "../core/jobs/repo.js";
import type { MintRequest } from "../core/mint/types.js";
import { broadcastAndTrack, prepareAll, trackReceipts } from "../core/mint/executor.js";
import { notifyJobDone } from "../bot/notify.js";
import { getChain } from "../config/chains.js";
import { log } from "../util/log.js";

const PRESIGN_LEAD_MS = 3000;
const SAFETY_MARGIN_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function qstashEnabled() {
  return Boolean(env.qstashToken);
}

/** Scheduled fire time. Mint Now (null runAt) uses frozen startedAt once claimed; before claim falls back to now. */
const runAtMs = (j: Pick<JobRecord, "runAt" | "startedAt" | "request">) => {
  const base = j.runAt ? new Date(j.runAt).getTime() : j.startedAt ? new Date(j.startedAt).getTime() : Date.now();
  return base + ((j.request as MintRequest)?.offsetMs ?? 0);
};

/** Publish (or re-publish) the QStash trigger for a job. Idempotent via deduplicationId. */
export async function publishJob(job: JobRecord, attempt = 0) {
  if (!qstashEnabled()) return null;
  const { Client } = await import("@upstash/qstash");
  const client = new Client({ token: env.qstashToken!, ...(env.qstashUrl ? { baseUrl: env.qstashUrl } : {}) });
  const fireAt = runAtMs(job) - env.jobLeadMs;
  const notBefore = Math.floor(fireAt / 1000);
  const res = await client.publishJSON({
    url: `${env.publicUrl}/api/jobs/run`,
    body: { jobId: job.id },
    ...(fireAt > Date.now() + 1000 ? { notBefore } : {}),
    deduplicationId: `job-${job.id}-${attempt}`,
    retries: 2,
  });
  await appendJobLog(job.id, `QStash scheduled (fire ${new Date(Math.max(fireAt, Date.now())).toISOString()}, msg ${res.messageId})`);
  return res.messageId;
}

/** Idempotent: create/replace the QStash cron that calls /api/cron/housekeeping (every 2 minutes). */
export async function ensureHousekeepingSchedule() {
  if (!qstashEnabled()) return { housekeeping: "skipped (QStash not configured)" };
  const { Client } = await import("@upstash/qstash");
  const client = new Client({ token: env.qstashToken!, ...(env.qstashUrl ? { baseUrl: env.qstashUrl } : {}) });
  const destination = `${env.publicUrl}/api/cron/housekeeping`;
  const { scheduleId } = await client.schedules.create({
    scheduleId: "skybot-housekeeping",
    destination,
    cron: "*/2 * * * *",
    method: "POST",
    retries: 1,
  });
  return { housekeeping: { scheduleId, destination, cron: "*/2 * * * *" } };
}

export async function enqueueMint(userId: string, req: MintRequest, gasHints: Record<string, string>): Promise<JobRecord> {
  const job = await insertJob(userId, req, gasHints);
  if (qstashEnabled()) {
    try {
      await publishJob(job);
    } catch (e: any) {
      await patchJob(job.id, { status: "failed", error: `could not schedule: ${String(e?.message ?? e).slice(0, 200)}` });
      throw Object.assign(new Error("Scheduler unavailable (QStash). Job not scheduled."), { statusCode: 503 });
    }
  }
  return (await getJob(userId, job.id))!;
}

/** Statuses a job can still be cancelled from (running only until the first broadcast, see beginBroadcast). */
export const CANCELLABLE = ["scheduled", "waiting_unlock", "running"] as const;

/** True when the UI / bot should offer Cancel for this job. */
export const isCancellable = (j: Pick<JobRecord, "status" | "broadcastAt">) =>
  (CANCELLABLE as readonly string[]).includes(j.status) && !(j.status === "running" && j.broadcastAt);

export const ALREADY_SENT_MESSAGE =
  "This mint already sent its transactions, so it can't be cancelled (they are on-chain). It will finish on its own.";

/**
 * Cancel a job. Owner-scoped; admins (actor.admin) may cancel any job. Allowed while scheduled / waiting, and while
 * running until the runner starts broadcasting (jobs.broadcast_at). One conditional UPDATE decides the race with the
 * runner's claim and with beginBroadcast, so a job is either cancelled with nothing sent or it sends and the cancel
 * is refused — never both.
 */
export async function cancelJob(actor: string | { id: string; admin?: boolean }, id: string): Promise<JobRecord> {
  const a = typeof actor === "string" ? { id: actor, admin: false } : actor;
  const j = await getJob(a.admin ? null : a.id, id);
  if (!j) throw Object.assign(new Error("job not found"), { statusCode: 404 });
  if (j.status === "running" && j.broadcastAt) throw Object.assign(new Error(ALREADY_SENT_MESSAGE), { statusCode: 409 });
  if (!isCancellable(j)) throw Object.assign(new Error(`cannot cancel a ${j.status} job`), { statusCode: 409 });
  const by = a.id === j.userId ? "owner" : "admin";
  const r = await getDb()
    .update(jobs)
    .set({ status: "cancelled", error: `Cancelled by ${by}. Nothing was sent; no gas was spent.` })
    .where(
      and(
        eq(jobs.id, id),
        or(inArray(jobs.status, ["scheduled", "waiting_unlock"]), and(eq(jobs.status, "running"), isNull(jobs.broadcastAt))),
      ),
    )
    .returning({ id: jobs.id });
  if (!r.length) {
    const now = await getJob(null, id);
    if (now?.broadcastAt) throw Object.assign(new Error(ALREADY_SENT_MESSAGE), { statusCode: 409 });
    throw Object.assign(new Error(`cannot cancel a ${now?.status ?? "missing"} job`), { statusCode: 409 });
  }
  await appendJobLog(id, `cancelled by ${by}${j.status === "running" ? " before broadcast (signed txs discarded)" : ""}`);
  return (await getJob(null, id))!;
}

/** Atomic claim: only one invocation can move scheduled → running. */
export async function claimJob(id: string): Promise<JobRecord | null> {
  const startedAt = new Date().toISOString();
  const r = await getDb()
    .update(jobs)
    .set({ status: "running", startedAt })
    .where(and(eq(jobs.id, id), eq(jobs.status, "scheduled")))
    .returning({ id: jobs.id });
  return r.length ? getJob(null, id) : null;
}

export type RunOutcome = { status: "skipped" | "requeued" | "done" | "failed"; reason?: string };

/**
 * Execute a job. `budgetMs` = time left in this invocation (serverless max duration).
 */
export async function runJob(id: string, budgetMs = env.jobMaxDurationSec * 1000): Promise<RunOutcome> {
  const started = Date.now();
  const deadline = started + budgetMs - SAFETY_MARGIN_MS;
  const peek = await getJob(null, id);
  if (!peek) return { status: "skipped", reason: "not found" };
  if (peek.status !== "scheduled") return { status: "skipped", reason: `status ${peek.status}` };

  const fireAt = runAtMs(peek);
  // Fired too early for this invocation's budget (e.g. QStash delay > lead) → re-publish closer to start.
  if (qstashEnabled() && fireAt - Date.now() > env.jobLeadMs + 30_000) {
    await publishJob(peek, Date.now());
    return { status: "requeued", reason: "too early" };
  }

  const job = await claimJob(id);
  if (!job) return { status: "skipped", reason: "already claimed" };
  const req = job.request as MintRequest & { gasHints: Record<string, string> };
  try {
    // Cancelled between the claim and here: stop before any signing.
    if ((await jobStatus(id)) === "cancelled") throw new JobCancelledError();
    if (!privyServerSigningReady()) {
      const { SIGNING_OFF_MESSAGE } = await import("../users/mintSigner.js");
      await patchRunningJob(id, { status: "failed", error: SIGNING_OFF_MESSAGE });
      await notifyJobDone(id);
      return { status: "failed", reason: "signing not configured" };
    }
    // Signing key unreadable / not in the quorum: fail now with the reason instead of per-wallet Privy errors.
    {
      const { mintSignerDiag, KEY_UNREADABLE_MESSAGE, KEY_NOT_IN_QUORUM_MESSAGE } = await import("../users/mintSigner.js");
      const diag = await mintSignerDiag().catch(() => null);
      const bad = diag && !diag.keyReadable ? KEY_UNREADABLE_MESSAGE : diag?.keyInQuorum === false ? KEY_NOT_IN_QUORUM_MESSAGE : null;
      if (bad) {
        await patchRunningJob(id, { status: "failed", error: bad });
        await notifyJobDone(id);
        return { status: "failed", reason: "signing key misconfigured" };
      }
    }
    const buildDeadline = Math.min(Math.max(fireAt + 30_000, Date.now() + 30_000), deadline - 5_000);
    const presignAt = req.strategy === "opensea_api" ? fireAt : fireAt - PRESIGN_LEAD_MS;
    // Pre-sign wait: re-check for a cancel about once a second.
    let lastCheck = Date.now();
    while (Date.now() < presignAt) {
      await sleep(Math.min(200, presignAt - Date.now()));
      if (Date.now() - lastCheck >= 1000) {
        lastCheck = Date.now();
        if ((await jobStatus(id)) === "cancelled") throw new JobCancelledError();
      }
    }
    const { prepared, results } = await prepareAll(job, req, req.gasHints ?? {}, buildDeadline);
    // Precise wait: coarse sleep, then tight spin for the last few ms.
    while (Date.now() < fireAt - 30) await sleep(Math.min(100, fireAt - 30 - Date.now()));
    while (Date.now() < fireAt) {
      /* spin ≤30ms */
    }
    // Cancel gate: atomically claim the right to broadcast. Lost → the job was cancelled; signed txs are discarded.
    if (!(await beginBroadcast(id))) throw new JobCancelledError();
    await appendJobLog(
      id,
      `broadcast at ${new Date().toISOString()} (target ${new Date(fireAt).toISOString()}, drift ${Date.now() - fireAt}ms)`,
    );
    await broadcastAndTrack(job, req, prepared, results, Math.max(5_000, deadline - Date.now()));
    const pending = results.some((r) => r.status === "broadcast");
    const failed = !pending && results.every((r) => ["failed", "reverted", "timeout"].includes(r.status));
    await patchJob(id, { status: pending ? "running" : failed ? "failed" : "done", results });
    if (!pending) await notifyJobDone(id);
    return { status: failed ? "failed" : "done" };
  } catch (e: any) {
    if (e instanceof JobCancelledError || (await jobStatus(id)) === "cancelled") {
      await appendJobLog(id, "runner stopped: job was cancelled (nothing broadcast)").catch(() => {});
      return { status: "skipped", reason: "cancelled" };
    }
    const { jobFailureMessage } = await import("../core/mint/jobErrors.js");
    const chain = getChain(req.chain);
    const error = await jobFailureMessage(e, chain ? { chain, contract: req.contract } : undefined).catch(() =>
      String(e?.message ?? e).slice(0, 400),
    );
    // If some wallets already broadcast, keep running so housekeeping can finish receipts / keep tx hashes.
    const cur = await getJob(null, id);
    const pending = Boolean(cur?.results?.some((r: any) => r.status === "broadcast"));
    await patchRunningJob(id, {
      status: pending ? "running" : "failed",
      error: pending ? `Interrupted after broadcast: ${error}` : error,
    });
    log.error(`job ${id} failed`, e);
    if (!pending) await notifyJobDone(id);
    return { status: pending ? "done" : "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Housekeeping: finish receipt tracking, fail stuck/missed jobs, purge expired link codes. */
export async function housekeeping() {
  const now = Date.now();
  const out = { finished: 0, stuck: 0, missed: 0, purgedCodes: 0 };
  for (const j of await listActiveJobs()) {
    const req = j.request as MintRequest;
    const fireAt = runAtMs(j);
    if (j.status === "running" && j.results.some((r: any) => r.status === "broadcast")) {
      const final = now - fireAt > 15 * 60_000;
      await trackReceipts(j, req, j.results, 3_000, final);
      const still = j.results.some((r: any) => r.status === "broadcast");
      if (!still) {
        const failed = j.results.every((r: any) => ["failed", "reverted", "timeout"].includes(r.status));
        await patchJob(j.id, { status: failed ? "failed" : "done", results: j.results });
        await notifyJobDone(j.id);
        out.finished++;
      } else await patchJob(j.id, { results: j.results });
    } else if (j.status === "running" && now - fireAt > 15 * 60_000) {
      if (await patchRunningJob(j.id, { status: "failed", error: "stuck in running (function timed out?)" })) {
        await notifyJobDone(j.id);
        out.stuck++;
      }
    } else if (j.status === "scheduled" && now - fireAt > 5 * 60_000) {
      // Conditional: a cancel that lands between the list and here wins.
      if (await patchJobIfStatus(j.id, "scheduled", { status: "failed", error: "missed start time (trigger not delivered)" })) {
        await notifyJobDone(j.id);
        out.missed++;
      }
    }
  }
  const del = await getDb()
    .delete(telegramLinks)
    .where(lt(telegramLinks.expiresAt, new Date(now).toISOString()))
    .returning({ code: telegramLinks.code });
  out.purgedCodes = del.length;
  // Sign-in-only signer: fix wallet ids and confirm the signer on wallets not yet verified (each at most every 6 h).
  try {
    const { backfillSiweSigners } = await import("../users/siweSigner.js");
    (out as any).siweSigners = await backfillSiweSigners();
  } catch (e: any) {
    log.warn("siwe signer backfill", String(e?.message ?? e).slice(0, 160));
  }
  // Wallet origin (imported vs created) from Privy's record for rows not verified yet.
  try {
    const { reconcileWalletSources } = await import("../users/service.js");
    (out as any).walletSources = await reconcileWalletSources({ limit: 10 });
  } catch (e: any) {
    log.warn("wallet sources", String(e?.message ?? e).slice(0, 160));
  }
  // Webhook-driven NFT re-scans still due (backstop + second pass), then keep Alchemy webhooks in sync.
  try {
    const { processRescanQueue } = await import("../core/nft/rescan.js");
    (out as any).nftRescans = await processRescanQueue({ limit: 20 });
  } catch (e: any) {
    log.warn("nft rescan queue", String(e?.message ?? e).slice(0, 160));
  }
  // Tokens that still look unrevealed: cheap on-chain tokenURI re-check (reveals don't trigger transfer webhooks).
  try {
    const { recheckDueMetadata } = await import("../core/nft/holdings.js");
    (out as any).nftMetadata = await recheckDueMetadata({ limit: 3 });
  } catch (e: any) {
    log.warn("nft metadata recheck", String(e?.message ?? e).slice(0, 160));
  }
  try {
    const { syncAlchemyWebhooks } = await import("../core/alchemy/sync.js");
    const r = await syncAlchemyWebhooks({ mode: "auto" });
    (out as any).alchemyWebhooks = r.status;
  } catch (e: any) {
    log.warn("alchemy webhook sync", String(e?.message ?? e).slice(0, 160));
  }
  return out;
}

/* ---------------- local dev emulation (no QStash) ---------------- */
let timer: NodeJS.Timeout | null = null;
const inflight = new Set<string>();
export function startLocalScheduler() {
  if (timer || qstashEnabled()) return;
  timer = setInterval(() => {
    void (async () => {
      for (const j of await listActiveJobs()) {
        if (j.status !== "scheduled" || inflight.has(j.id)) continue;
        if (Date.now() + Math.min(env.jobLeadMs, 5_000) >= runAtMs(j)) {
          inflight.add(j.id);
          void runJob(j.id, 30 * 60_000).finally(() => inflight.delete(j.id));
        }
      }
    })().catch((e) => log.error("local scheduler tick", e));
  }, 250);
  setInterval(() => {
    void housekeeping().catch((e) => log.error("housekeeping", e));
  }, 60_000);
  log.info("Local scheduler started (QStash emulation)");
}
