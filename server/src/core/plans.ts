import { randomBytes } from "node:crypto";

export interface Plan<T = unknown> { id: string; userId: string; kind: "mint" | "fund" | "sweep"; createdAt: number; data: T; confirmPhrase: string }
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
  if (Date.now() - p.createdAt > TTL_MS) { plans.delete(id); throw Object.assign(new Error("Plan expired — simulate again"), { statusCode: 410 }); }
  if ((phrase ?? "").trim() !== p.confirmPhrase) throw Object.assign(new Error(`Confirmation phrase mismatch. Type exactly: ${p.confirmPhrase}`), { statusCode: 400 });
  plans.delete(id);
  return p as Plan<T>;
}
