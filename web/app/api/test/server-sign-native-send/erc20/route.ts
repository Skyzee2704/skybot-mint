// SPDX-License-Identifier: AGPL-3.0-only
import { server } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** ERC-20 transfer. POST only. Signed on the test path, not through the production selector denylist. */
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
    return Response.json(await s.runTestErc20Send(req.headers.get("x-test-send-token"), body));
  } catch (e) {
    const f = s.testSendFailure(e);
    const from =
      e && typeof e === "object" && typeof (e as { from?: unknown }).from === "string" ? (e as { from: string }).from : undefined;
    s.log.warn("test erc20 send failed", { code: f.code, status: f.status, error: f.message });
    return Response.json({ error: f.message, code: f.code, ...(from ? { from } : {}) }, { status: f.status });
  }
}
