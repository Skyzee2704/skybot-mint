// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin Gallery: private media (promo clips) bundled with the server function — never under web/public.
 * Registered inside the admin-gated scope, so every route here requires an allow-listed admin identity.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** server/assets/promo — same relative path from src/api (tests) and dist/api (Vercel, traced via next.config). */
const HERE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/promo");
/** First existing candidate (bundlers may rewrite import.meta.url; cwd is the repo root or web/ on Vercel). */
export const GALLERY_DIR =
  [HERE_DIR, path.join(process.cwd(), "server/assets/promo"), path.join(process.cwd(), "../server/assets/promo")].find((d) =>
    fs.existsSync(d),
  ) ?? HERE_DIR;

export type GalleryItem = { name: string; title: string; aspect: string; type: string };

/** Allow-list: only these files can ever be served (no path input reaches the filesystem). */
export const GALLERY_ITEMS: GalleryItem[] = [
  { name: "skybot_mint_16x9.mp4", title: "Promo clip · 16:9 (X / YouTube)", aspect: "16 / 9", type: "video/mp4" },
  { name: "skybot_mint_1x1.mp4", title: "Promo clip · 1:1 (feed)", aspect: "1 / 1", type: "video/mp4" },
];

function parseRange(h: string | undefined, size: number): [number, number] | null | "invalid" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return [start, end];
}

export function registerGalleryRoutes(ad: FastifyInstance) {
  ad.get("/api/admin/gallery", async () => ({
    items: GALLERY_ITEMS.map((i) => {
      let size: number | null = null;
      try {
        size = fs.statSync(path.join(GALLERY_DIR, i.name)).size;
      } catch {
        /* missing file → size null; the UI shows it as unavailable */
      }
      return { ...i, size };
    }),
  }));

  ad.get("/api/admin/gallery/media/:name", async (req, reply) => {
    const name = (req.params as any).name as string;
    const item = GALLERY_ITEMS.find((i) => i.name === name);
    if (!item) return reply.code(404).send({ error: "Not found" });
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(path.join(GALLERY_DIR, item.name));
    } catch {
      return reply.code(404).send({ error: "Media file missing on server" });
    }
    const download = (req.query as any)?.download === "1";
    reply
      .header("content-type", item.type)
      .header("accept-ranges", "bytes")
      .header("cache-control", "private, no-store")
      .header("content-disposition", `${download ? "attachment" : "inline"}; filename="${item.name}"`);
    const range = parseRange(req.headers.range, buf.length);
    if (range === "invalid") return reply.code(416).header("content-range", `bytes */${buf.length}`).send();
    if (range) {
      const [s, e] = range;
      return reply
        .code(206)
        .header("content-range", `bytes ${s}-${e}/${buf.length}`)
        .send(buf.subarray(s, e + 1));
    }
    return reply.send(buf);
  });
}
