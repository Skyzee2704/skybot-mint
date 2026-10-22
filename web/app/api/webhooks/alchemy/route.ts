// SPDX-License-Identifier: AGPL-3.0-only
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Alchemy Address Activity webhook (minimal: acknowledges deliveries; processing ships next). */
export async function POST(req: Request) {
  await req.text();
  return Response.json({ ok: true });
}
