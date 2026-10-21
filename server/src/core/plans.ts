import { randomBytes } from "node:crypto";

/** Short-lived server-side plans: preview -> explicit confirm. Prevents one-click/forged executions. */
export interface Plan<T = unknown> { id: string; kind: "mint" | "fund" | "sweep"; createdAt: number; data: T; confirmPhrase: string }
const plans = new Map<string, Plan>();
const TTL = 10 * 60_000;

export function createPlan<T>(kind: Plan["kind"], data: T, confirmPhrase: string): Plan<T> {
  for (const [k, p] of plans) if (Date.now() - p.createdAt > TTL) plans.delete(k);
  const p: Plan<T> = { id: randomBytes(12).toString("hex"), kind, createdAt: Date.now(), data, confirmPhrase };
  plans.set(p.id, p);
  return p;
}
/** Consumes the plan (single use). The caller must echo the exact confirm phrase. */
export function consumePlan<T>(id: string, kind: Plan["kind"], phrase: string): Plan<T> {
  const p = plans.get(id);
  if (!p || p.kind !== kind || Date.now() - p.createdAt > TTL) throw Object.assign(new Error("Plan not found or expired — run the preview again"), { statusCode: 410 });
  if ((phrase ?? "").trim() !== p.confirmPhrase) throw Object.assign(new Error(`Confirmation phrase mismatch. Type exactly: ${p.confirmPhrase}`), { statusCode: 400 });
  plans.delete(id);
  return p as Plan<T>;
}
