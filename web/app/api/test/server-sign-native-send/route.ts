// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Draft-only probe. POST is the only method. The body may set an allowlisted wallet, a repo chain, a positive
 * native amount, and a destination. Signing uses the SIWE authorization key only. The gate is the
 * `x-test-send-token` header, compared to `TEST_SEND_TOKEN`. Unset env disables the endpoint.
 */
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
    const result = await s.runTestNativeSend(req.headers.get("x-test-send-token"), body);
    return Response.json(result);
  } catch (e) {
    const f = s.testSendFailure(e);
    const from =
      e && typeof e === "object" && typeof (e as { from?: unknown }).from === "string" ? (e as { from: string }).from : undefined;
    s.log.warn("test native send failed", { code: f.code, status: f.status, error: f.message });
    return Response.json({ error: f.message, code: f.code, ...(from ? { from } : {}) }, { status: f.status });
  }
}
