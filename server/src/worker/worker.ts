import { randomUUID } from "node:crypto";
import { getStore, JobRecord } from "../core/store.js";
import { session } from "../core/keystore/session.js";
import { MintRequest } from "../core/mint/types.js";
import { broadcastAndTrack, prepareAll } from "../core/mint/executor.js";
import { log } from "../util/log.js";

/**
 * In-process job worker. Runs in the API process because signing needs the unlocked KEK,
 * which lives only in that process' memory (never on disk, never sent to another process).
 *
 * Timeline for a scheduled job (runAt = stage start):
 *   runAt - PRESIGN_LEAD_MS : build + sign (seadrop_public / generic)
 *   runAt + offsetMs        : broadcast to all RPCs
 * opensea_api jobs build at runAt (the official API returns 409 until the stage is live) and retry for 30s.
 */
const PRESIGN_LEAD_MS = 3000;
const TICK_MS = 200;
const UNLOCK_GRACE_MS = 5 * 60_000;
const running = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const listeners = new Set<(j: JobRecord) => void>();
export const onJobUpdate = (fn: (j: JobRecord) => void) => { listeners.add(fn); return () => listeners.delete(fn); };

function patch(id: string, p: Partial<JobRecord>) {
  const j = getStore().update((d) => { const j = d.jobs.find((x) => x.id === id); if (j) Object.assign(j, p); return j; });
  if (j) listeners.forEach((fn) => fn(j));
}

export function enqueueMint(req: MintRequest, gasHints: Record<string, string>): JobRecord {
  const job: JobRecord = {
    id: randomUUID(), createdAt: new Date().toISOString(), status: "scheduled", runAt: req.runAt ?? null,
    chain: req.chain, target: req.contract, strategy: req.strategy, request: { ...req, gasHints }, results: [], log: [],
  };
  getStore().update((d) => { d.jobs.unshift(job); if (d.jobs.length > 500) d.jobs.length = 500; });
  return job;
}

export function cancelJob(id: string) {
  const j = getStore().db.jobs.find((x) => x.id === id);
  if (!j) throw Object.assign(new Error("job not found"), { statusCode: 404 });
  if (running.has(id)) throw Object.assign(new Error("job is already running"), { statusCode: 409 });
  if (j.status !== "scheduled" && j.status !== "waiting_unlock") throw Object.assign(new Error(`cannot cancel a ${j.status} job`), { statusCode: 409 });
  patch(id, { status: "cancelled" });
}

async function run(job: JobRecord) {
  running.add(job.id);
  const req = job.request as MintRequest & { gasHints: Record<string, string> };
  const runAt = job.runAt ? new Date(job.runAt).getTime() : Date.now();
  const offset = Math.max(-5000, Math.min(60_000, req.offsetMs ?? 0));
  try {
    patch(job.id, { status: "running" });
    if (req.strategy === "opensea_api" && Date.now() < runAt) await new Promise((r) => setTimeout(r, runAt - Date.now()));
    const buildDeadline = Math.max(Date.now(), runAt) + 30_000;
    const { prepared, results } = await prepareAll(job, req, req.gasHints ?? {}, buildDeadline);
    patch(job.id, { results });
    const fireAt = runAt + offset;
    if (Date.now() < fireAt) await new Promise((r) => setTimeout(r, fireAt - Date.now()));
    await broadcastAndTrack(job, req, prepared, results);
    const ok = results.some((r) => r.status === "confirmed");
    patch(job.id, { status: ok ? "done" : "failed", results, error: ok ? undefined : "no wallet minted successfully" });
  } catch (e: any) {
    log.error(`job ${job.id} failed`, e);
    patch(job.id, { status: "failed", error: String(e.message).slice(0, 400) });
  } finally { running.delete(job.id); }
}

export function tick(now = Date.now()) {
  for (const j of getStore().db.jobs) {
    if (running.has(j.id)) continue;
    if (j.status !== "scheduled" && j.status !== "waiting_unlock") continue;
    const runAt = j.runAt ? new Date(j.runAt).getTime() : now;
    const startAt = j.strategy === "opensea_api" ? runAt - 1000 : runAt - PRESIGN_LEAD_MS;
    if (now < startAt) continue;
    if (!session.unlocked) {
      if (now > runAt + UNLOCK_GRACE_MS) patch(j.id, { status: "failed", error: "keystore was locked at run time" });
      else if (j.status !== "waiting_unlock") patch(j.id, { status: "waiting_unlock" });
      continue;
    }
    void run(j);
  }
}

export function startWorker() {
  if (timer) return;
  // Jobs that were mid-flight when the process died are marked failed (tx state must be checked manually).
  getStore().update((d) => d.jobs.forEach((j) => { if (j.status === "running") { j.status = "failed"; j.error = "process restarted during execution — check explorer"; } }));
  timer = setInterval(() => { try { tick(); } catch (e) { log.error("worker tick", e); } }, TICK_MS);
  timer.unref?.();
  log.info("Worker started");
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }
