// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

export interface Plan<T = unknown> {
  id: string;
  userId: string;
  kind: "mint" | "fund" | "sweep";
  createdAt: number;
  data: T;
  confirmPhrase: string;
}
const TTL_MS = 10 * 60_000;
const plans = new Map<string, Plan>();

export function createPlan<T>(userId: string, kind: Plan["kind"], data: T, confirmPhrase: string): Plan<T> {
  const p: Plan<T> = { id: randomBytes(12).toString("hex"), userId, kind, createdAt: Date.now(), data, confirmPhrase };
  plans.set(p.id, p as Plan);
  return p;
}

export function consumePlan<T>(userId: string, id: string, kind: Plan["kind"], phrase: string): Plan<T> {
  const p = plans.get(id);
  if (!p || p.kind !== kind) throw Object.assign(new Error("Plan not found or expired — simulate again"), { statusCode: 404 });
  if (p.userId !== userId) throw Object.assign(new Error("Plan belongs to another user"), { statusCode: 403 });
  if (Date.now() - p.createdAt > TTL_MS) {
    plans.delete(id);
    throw Object.assign(new Error("Plan expired — simulate again"), { statusCode: 410 });
  }
  if ((phrase ?? "").trim() !== p.confirmPhrase)
    throw Object.assign(new Error("Confirmation doesn't match this mint plan. Simulate again and confirm."), { statusCode: 400 });
  plans.delete(id);
  return p as Plan<T>;
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
