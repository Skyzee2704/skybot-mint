// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby max = 300s. On Pro you can raise to 800 — also set JOB_MAX_DURATION_SEC to match.
export const maxDuration = 300;

/** QStash → run a scheduled mint. Signature-verified; idempotent via atomic claim in runJob. */
export async function POST(req: Request) {
  const s = await server();
  const raw = await req.text();
  const url = `${s.env.publicUrl}/api/jobs/run`;
  if (!(await s.verifyQStash(req.headers.get("upstash-signature"), raw, url))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  let jobId: string;
  try {
    jobId = String(JSON.parse(raw).jobId ?? "");
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return Response.json({ error: "bad jobId" }, { status: 400 });
  await s.ensureDb();
  const started = Date.now();
  const out = await s.runJob(jobId, s.env.jobMaxDurationSec * 1000 - (Date.now() - started));
  // 200 for every handled outcome so QStash doesn't retry a job that already ran / failed deterministically.
  return Response.json(out);
}
