// SPDX-License-Identifier: AGPL-3.0-only
import { after } from "next/server";
import { server } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Alchemy Address Activity webhook. The raw body is verified (X-Alchemy-Signature, per-webhook signing key) before
 * anything happens; unverified requests (e.g. the dashboard test) get 200 and are ignored. The debounced NFT
 * re-scan runs after the response so Alchemy gets a fast 200.
 */
export async function POST(req: Request) {
  const s = await server();
  const raw = await req.text();
  try {
    await s.ensureDb();
  } catch {
    return Response.json({ error: "temporarily unavailable" }, { status: 503 });
  }
  const r = await s.handleAlchemyWebhook(raw, req.headers.get("x-alchemy-signature"));
  if (r.followUp) after(r.followUp);
  return Response.json(r.body, { status: r.status });
}
