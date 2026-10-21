import "server-only";
// SPDX-License-Identifier: AGPL-3.0-only
/** Lazily build the Fastify app once per serverless instance and serve requests via inject(). */
type Srv = typeof import("@nft-mint-bot/server");
let mod: Promise<Srv> | null = null;
let appP: Promise<any> | null = null;
export const server = () => (mod ??= import("@nft-mint-bot/server"));

async function app() {
  appP ??= (async () => {
    const s = await server();
    const a = await s.buildServer();
    await a.ready();
    return a;
  })().catch((e) => {
    appP = null;
    throw e;
  });
  return appP;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "host"]);

export async function forward(req: Request): Promise<Response> {
  const a = await app();
  const u = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!HOP.has(k)) headers[k] = v;
  });
  const payload = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());
  const r = await a.inject({
    method: req.method,
    url: u.pathname + u.search,
    headers,
    payload,
    remoteAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  const out = new Headers();
  for (const [k, v] of Object.entries(r.headers)) {
    if (v === undefined || HOP.has(k)) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, String(x)));
    else out.set(k, String(v));
  }
  return new Response(req.method === "HEAD" ? null : r.rawPayload, { status: r.statusCode, headers: out });
}
