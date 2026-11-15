// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Balance and token read. POST only, same TEST_SEND_TOKEN gate as the send. */
export async function POST(req: Request) {
  const s = await server();
  let body: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Request body must be JSON.", code: "BAD_BODY" }, { status: 400 });
    }
  }
  try {
    return Response.json(await s.runTestLookup(req.headers.get("x-test-send-token"), body));
  } catch (e) {
    const f = s.testSendFailure(e);
    s.log.warn("test lookup failed", { code: f.code, status: f.status, error: f.message });
    return Response.json({ error: f.message, code: f.code }, { status: f.status });
  }
}
