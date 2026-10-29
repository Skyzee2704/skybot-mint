// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { plans as plansTable } from "../db/schema.js";

export interface Plan<T = unknown> {
  id: string;
  userId: string;
  kind: "mint" | "fund" | "sweep";
  createdAt: number;
  data: T;
  confirmPhrase: string;
}
const TTL_MS = 10 * 60_000;

export async function createPlan<T>(userId: string, kind: Plan["kind"], data: T, confirmPhrase: string): Promise<Plan<T>> {
  const createdAt = Date.now();
  const id = randomBytes(12).toString("hex");
  const p: Plan<T> = { id, userId, kind, createdAt, data, confirmPhrase };
  await getDb()
    .insert(plansTable)
    .values({
      id,
      userId,
      kind,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + TTL_MS).toISOString(),
      dataJson: JSON.stringify(data),
      confirmPhrase,
    });
  // Best-effort purge of expired rows (keeps the table small without a separate cron).
  void getDb()
    .delete(plansTable)
    .where(lt(plansTable.expiresAt, new Date().toISOString()))
    .catch(() => {});
  return p;
}

export async function consumePlan<T>(userId: string, id: string, kind: Plan["kind"], phrase: string): Promise<Plan<T>> {
  const found = await getDb().select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
  const row = found[0];
  if (!row || row.kind !== kind) throw Object.assign(new Error("Plan not found or expired — simulate again"), { statusCode: 404 });
  if (row.userId !== userId) throw Object.assign(new Error("Plan belongs to another user"), { statusCode: 403 });
  if (Date.now() > new Date(row.expiresAt).getTime()) {
    await getDb().delete(plansTable).where(eq(plansTable.id, id));
    throw Object.assign(new Error("Plan expired — simulate again"), { statusCode: 410 });
  }
  if ((phrase ?? "").trim() !== row.confirmPhrase)
    throw Object.assign(new Error("Confirmation doesn't match this mint plan. Simulate again and confirm."), { statusCode: 400 });
  // Atomic single-use: only one concurrent confirm wins the delete.
  const deleted = await getDb()
    .delete(plansTable)
    .where(and(eq(plansTable.id, id), eq(plansTable.userId, userId)))
    .returning();
  if (!deleted.length) throw Object.assign(new Error("Plan not found or expired — simulate again"), { statusCode: 404 });
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as Plan["kind"],
    createdAt: new Date(row.createdAt).getTime(),
    data: JSON.parse(row.dataJson) as T,
    confirmPhrase: row.confirmPhrase,
  };
}

/**
 * Checkbox confirmation (web + Mini App Mint confirm): the member ticked "I confirm this will broadcast real
 * transactions (N mints …)". The client must send confirmed: true plus the mint count it showed; the server only
 * accepts it when that count matches the plan, so a stale or different confirmation can't execute another plan.
 */
export function mintConfirmation(b: { confirmed?: boolean; nfts?: number; confirmPhrase?: string }): string {
  if (b.confirmPhrase !== undefined) return b.confirmPhrase; // legacy typed phrase (older clients)
  if (b.confirmed !== true || !Number.isInteger(b.nfts))
    throw Object.assign(new Error("Tick the confirmation box to broadcast the mint."), { statusCode: 400 });
  return `MINT ${b.nfts}`;
}
