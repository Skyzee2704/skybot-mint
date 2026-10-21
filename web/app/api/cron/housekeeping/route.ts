// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** QStash schedule (e.g. every 2 min) → finish receipts, fail stuck/missed jobs, purge expired link codes. */
export async function POST(req: Request) {
  const s = await server();
  const raw = await req.text();
  if (!(await s.verifyQStash(req.headers.get("upstash-signature"), raw, `${s.env.publicUrl}/api/cron/housekeeping`))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  await s.ensureDb();
  return Response.json(await s.housekeeping());
}
