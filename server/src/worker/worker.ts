import { insertJob, getJob, listActiveJobs, patchJob, type JobRecord } from "../core/jobs/repo.js";
import { MintRequest } from "../core/mint/types.js";
import { broadcastAndTrack, prepareAll } from "../core/mint/executor.js";
import { privyServerSigningReady } from "../auth/privy.js";
import { log } from "../util/log.js";

const PRESIGN_LEAD_MS = 3000;
const TICK_MS = 250;
const running = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const listeners = new Set<(j: JobRecord) => void>();
export const onJobUpdate = (fn: (j: JobRecord) => void) => { listeners.add(fn); return () => listeners.delete(fn); };

async function notify(id: string) {
  const j = await getJob(null, id);
  if (j) listeners.forEach((fn) => fn(j));
}

export async function enqueueMint(userId: string, req: MintRequest, gasHints: Record<string, string>): Promise<JobRecord> {
  if (!privyServerSigningReady()) {
    // Still enqueue — worker will mark waiting_unlock / fail with a clear message if signing isn't ready at run time.
  }
  const job = await insertJob(userId, req, gasHints);
  listeners.forEach((fn) => fn(job));
  return job;
}

export async function cancelJob(userId: string, id: string) {
  const j = await getJob(userId, id);
  if (!j) throw Object.assign(new Error("job not found"), { statusCode: 404 });
  if (running.has(id)) throw Object.assign(new Error("job is already running"), { statusCode: 409 });
  if (j.status !== "scheduled" && j.status !== "waiting_unlock") throw Object.assign(new Error(`cannot cancel a ${j.status} job`), { statusCode: 409 });
  await patchJob(id, { status: "cancelled" });
  await notify(id);
}

async function run(job: JobRecord) {
  running.add(job.id);
  const req = job.request as MintRequest & { gasHints: Record<string, string> };
  const runAt = job.runAt ? new Date(job.runAt).getTime() : Date.now();
  const offset = req.offsetMs ?? 0;
  try {
    if (!privyServerSigningReady()) {
      await patchJob(job.id, { status: "failed", error: "Server signing not configured (PRIVY_AUTH_PRIVATE_KEY + key quorum as session signer on wallets). See README." });
      await notify(job.id); return;
    }
    await patchJob(job.id, { status: "running" }); await notify(job.id);
    const buildDeadline = Math.max(runAt + offset + 30_000, Date.now() + 30_000);
    // Pre-sign ~3s before broadcast for on-chain strategies; OpenSea API builds at/after runAt.
    const presignAt = req.strategy === "opensea_api" ? runAt + offset : runAt + offset - PRESIGN_LEAD_MS;
    while (Date.now() < Math.min(presignAt, runAt + offset)) await new Promise((r) => setTimeout(r, 50));
    const { prepared, results } = await prepareAll(job, req, req.gasHints ?? {}, buildDeadline);
    while (Date.now() < runAt + offset) await new Promise((r) => setTimeout(r, 20));
    await broadcastAndTrack(job, req, prepared, results);
    const failed = results.every((r) => r.status === "failed" || r.status === "reverted" || r.status === "timeout");
    await patchJob(job.id, { status: failed ? "failed" : "done", results });
  } catch (e: any) {
    await patchJob(job.id, { status: "failed", error: String(e?.message ?? e).slice(0, 400) });
    log.error(`job ${job.id} failed`, e);
  } finally {
    running.delete(job.id);
    await notify(job.id);
  }
}

async function tick() {
  const active = await listActiveJobs();
  for (const j of active) {
    if (running.has(j.id) || j.status === "running") continue;
    if (j.status === "waiting_unlock") {
      if (privyServerSigningReady()) { await patchJob(j.id, { status: "scheduled" }); await notify(j.id); }
      continue;
    }
    if (!privyServerSigningReady()) {
      await patchJob(j.id, { status: "waiting_unlock" }); await notify(j.id); continue;
    }
    const runAt = j.runAt ? new Date(j.runAt).getTime() : Date.now();
    const lead = (j.request as any)?.strategy === "opensea_api" ? 0 : PRESIGN_LEAD_MS;
    if (Date.now() + lead + 500 >= runAt) void run(j);
  }
}

export function startWorker() {
  if (timer) return;
  timer = setInterval(() => { void tick().catch((e) => log.error("worker tick", e)); }, TICK_MS);
  log.info("Worker started");
}
export function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }
