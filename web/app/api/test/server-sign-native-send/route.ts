// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Draft-only probe. POST is the only method. The body is never read: source wallet, destination,
 * amount, and chain id are constants inside `runTestNativeSend`. The gate is the `x-test-send-token`
 * header, compared to `TEST_SEND_TOKEN`. Unset env disables the endpoint.
 */
export async function POST(req: Request) {
  const s = await server();
  try {
    const result = await s.runTestNativeSend(req.headers.get("x-test-send-token"));
    return Response.json(result);
  } catch (e) {
    const f = s.testSendFailure(e);
    s.log.warn("test native send failed", { code: f.code, status: f.status, error: f.message });
    return Response.json({ error: f.message, code: f.code }, { status: f.status });
  }
}
