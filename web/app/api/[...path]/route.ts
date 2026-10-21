// SPDX-License-Identifier: AGPL-3.0-only
import { forward } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const h = (req: Request) => forward(req);
export { h as GET, h as POST, h as PUT, h as PATCH, h as DELETE, h as OPTIONS, h as HEAD };
