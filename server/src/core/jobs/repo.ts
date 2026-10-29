// SPDX-License-Identifier: AGPL-3.0-only
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.js";
import { jobs, minted, spend } from "../../db/schema.js";
import type { MintRequest } from "../mint/types.js";

export interface JobRecord {
  id: string;
  userId: string;
  createdAt: string;
  status: "scheduled" | "running" | "done" | "failed" | "cancelled" | "waiting_unlock";
  runAt: string | null;
  /** Set once when claimed (scheduled → running). Anchors Mint Now housekeeping timeouts. */
  startedAt: string | null;
  /** Set right before the first broadcast (cancel gate). */
  broadcastAt: string | null;
  chain: string;
  target: string;
  strategy: string;
  request: any;
  results: any[];
  error?: string;
  log: string[];
}

function rowToJob(r: typeof jobs.$inferSelect): JobRecord {
  return {
    id: r.id,
    userId: r.userId,
    createdAt: r.createdAt,
    status: r.status as JobRecord["status"],
    runAt: r.runAt,
    startedAt: r.startedAt ?? null,
    broadcastAt: r.broadcastAt ?? null,
    chain: r.chain,
    target: r.target,
    strategy: r.strategy,
    request: JSON.parse(r.requestJson),
    results: JSON.parse(r.resultsJson || "[]"),
    error: r.error ?? undefined,
    log: JSON.parse(r.logJson || "[]"),
  };
}

export async function insertJob(userId: string, req: MintRequest, gasHints: Record<string, string>): Promise<JobRecord> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const request = { ...req, gasHints };
  await getDb()
    .insert(jobs)
    .values({
      id,
      userId,
      createdAt,
      status: "scheduled",
      runAt: req.runAt ?? null,
      startedAt: null,
      broadcastAt: null,
      chain: req.chain,
      target: req.contract,
      strategy: req.strategy,
      requestJson: JSON.stringify(request),
      resultsJson: "[]",
      logJson: "[]",
    });
  return rowToJob((await getDb().select().from(jobs).where(eq(jobs.id, id)))[0]!);
}

export async function getJob(userId: string | null, id: string): Promise<JobRecord | null> {
  const rows = userId
    ? await getDb()
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
        .limit(1)
    : await getDb().select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function listJobs(userId: string, limit = 100): Promise<JobRecord[]> {
  return (await getDb().select().from(jobs).where(eq(jobs.userId, userId)).orderBy(desc(jobs.createdAt)).limit(limit)).map(rowToJob);
}

export async function listActiveJobs(): Promise<JobRecord[]> {
  return (
    await getDb()
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["scheduled", "waiting_unlock", "running"]))
  ).map(rowToJob);
}

export async function patchJob(id: string, p: Partial<JobRecord>) {
  const set: any = {};
  if (p.status !== undefined) set.status = p.status;
  if (p.runAt !== undefined) set.runAt = p.runAt;
  if (p.startedAt !== undefined) set.startedAt = p.startedAt;
  if (p.error !== undefined) set.error = p.error;
  if (p.results !== undefined) set.resultsJson = JSON.stringify(p.results);
  if (p.log !== undefined) set.logJson = JSON.stringify(p.log);
  if (Object.keys(set).length) await getDb().update(jobs).set(set).where(eq(jobs.id, id));
}

/** Thrown by the runner/executor when the job was cancelled before broadcasting. */
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}

/** Like patchJob, but only while the job is still in `from` (never overwrites a cancel). Returns whether it applied. */
export async function patchJobIfStatus(id: string, from: JobRecord["status"], p: Partial<JobRecord>): Promise<boolean> {
  const set: any = {};
  if (p.status !== undefined) set.status = p.status;
  if (p.error !== undefined) set.error = p.error;
  if (p.results !== undefined) set.resultsJson = JSON.stringify(p.results);
  if (!Object.keys(set).length) return false;
  const r = await getDb()
    .update(jobs)
    .set(set)
    .where(and(eq(jobs.id, id), eq(jobs.status, from)))
    .returning({ id: jobs.id });
  return r.length > 0;
}

export const patchRunningJob = (id: string, p: Partial<JobRecord>) => patchJobIfStatus(id, "running", p);

/** Current status only (cheap re-check for the runner). */
export async function jobStatus(id: string): Promise<JobRecord["status"] | null> {
  const r = await getDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).limit(1);
  return (r[0]?.status as JobRecord["status"]) ?? null;
}

/**
 * Cancel gate, runner side: atomically mark that broadcasting starts. Fails (false) when the job was cancelled
 * (or is no longer running), so a cancel and a broadcast can never both win.
 */
export async function beginBroadcast(id: string): Promise<boolean> {
  const r = await getDb()
    .update(jobs)
    .set({ broadcastAt: new Date().toISOString() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running"), isNull(jobs.broadcastAt)))
    .returning({ id: jobs.id });
  return r.length > 0;
}

export async function appendJobLog(id: string, msg: string) {
  const j = await getJob(null, id);
  if (!j) return;
  j.log.push(`${new Date().toISOString()} ${msg}`);
  await patchJob(id, { log: j.log });
}

export async function recordMinted(
  userId: string,
  entry: { chain: string; contract: string; wallet: string; tokenIds: string[]; txHash: string },
) {
  await getDb()
    .insert(minted)
    .values({
      id: randomUUID(),
      userId,
      chain: entry.chain,
      contract: entry.contract,
      wallet: entry.wallet,
      tokenIdsJson: JSON.stringify(entry.tokenIds),
      txHash: entry.txHash,
      at: new Date().toISOString(),
    });
}

export async function listMinted(userId: string, limit = 500) {
  return (await getDb().select().from(minted).where(eq(minted.userId, userId)).orderBy(desc(minted.at)).limit(limit)).map((m) => ({
    chain: m.chain,
    contract: m.contract,
    wallet: m.wallet,
    tokenIds: JSON.parse(m.tokenIdsJson),
    txHash: m.txHash,
    at: m.at,
  }));
}

export async function recordSpendRow(userId: string, chain: string, wei: string, ref: string) {
  await getDb()
    .insert(spend)
    .values({ id: randomUUID(), userId, day: new Date().toISOString().slice(0, 10), chain, wei, at: new Date().toISOString(), ref });
}

export async function settleSpendRow(ref: string, actualWei: string) {
  await getDb().update(spend).set({ wei: actualWei }).where(eq(spend.ref, ref));
}

export async function dailySpentWei(userId: string, chain: string): Promise<bigint> {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await getDb()
    .select()
    .from(spend)
    .where(and(eq(spend.userId, userId), eq(spend.day, day), eq(spend.chain, chain)));
  return rows.reduce((a, r) => a + BigInt(r.wei), 0n);
}
