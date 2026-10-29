// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Renders the 1200×630 link-preview image (Open Graph / X card) to public/og.png.
 * Static on purpose: crawlers (X, Discord, Telegram, WhatsApp) get a plain cached file, no function cold start.
 *
 *   npm run og --workspace web            # → web/public/og.png
 *   node web/scripts/og-image.mjs out.png # → custom path
 *
 * Uses the satori + resvg renderer bundled with Next (next/og) and the fonts in scripts/og-fonts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..");
const require = createRequire(import.meta.url);
const { ImageResponse } = require("next/dist/compiled/@vercel/og/index.node.js");
const sharp = require("sharp");

const BLACK = "#070707";
const CREAM = "#f5e6d3";
const CREAM_DIM = "#cbbba6";
const ORANGE = "#ff6b1a";
const LINE = "rgba(245, 230, 211, 0.14)";

const font = (f) => fs.readFileSync(path.join(here, "og-fonts", f));
const logo = `data:image/png;base64,${fs.readFileSync(path.join(web, "public", "logo.png")).toString("base64")}`;

const h = (type, style, ...children) => ({ type, props: { style, children: children.length <= 1 ? children[0] : children } });
const img = (src, style) => ({ type: "img", props: { src, style } });

const tree = h(
  "div",
  {
    width: 1200,
    height: 630,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "56px 72px 44px",
    backgroundColor: BLACK,
    backgroundImage: [
      "radial-gradient(ellipse 70% 55% at 50% -12%, rgba(255,107,26,0.34), transparent 70%)",
      "radial-gradient(circle 360px at 960px 300px, rgba(255,107,26,0.20), transparent 75%)",
      "radial-gradient(ellipse 40% 30% at 8% 100%, rgba(245,230,211,0.06), transparent 80%)",
    ].join(", "),
    fontFamily: "Jakarta",
    color: CREAM,
  },
  h(
    "div",
    { display: "flex", alignItems: "center", justifyContent: "space-between" },
    h(
      "div",
      { display: "flex", flexDirection: "column", width: 740 },
      h(
        "div",
        {
          display: "flex",
          alignSelf: "flex-start",
          padding: "8px 18px",
          borderRadius: 999,
          border: `1px solid rgba(255,107,26,0.55)`,
          backgroundColor: "rgba(255,107,26,0.10)",
          color: ORANGE,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: 1,
        },
        "COMMUNITY MINT DESK",
      ),
      h(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          marginTop: 24,
          fontFamily: "Syne",
          fontSize: 78,
          lineHeight: 1.05,
          letterSpacing: -1,
          whiteSpace: "nowrap",
        },
        h("div", { color: "#ffffff" }, "Mint faster."),
        h("div", { color: ORANGE }, "Miss less."),
      ),
      h(
        "div",
        { marginTop: 26, fontSize: 27, lineHeight: 1.4, color: CREAM_DIM, maxWidth: 720 },
        "Paste any OpenSea drop or contract. Check every wallet, simulate gas, mint across your fleet — on web or Telegram.",
      ),
    ),
    img(logo, {
      width: 280,
      height: 280,
      borderRadius: 64,
      border: `2px solid rgba(255,107,26,0.45)`,
      boxShadow: "0 0 90px rgba(255,107,26,0.45)",
    }),
  ),
  h(
    "div",
    {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 22,
      borderTop: `1px solid ${LINE}`,
      fontSize: 24,
      fontWeight: 700,
      color: CREAM_DIM,
    },
    h("div", { display: "flex", alignItems: "center", color: CREAM }, "SkyBOT Mint"),
    h(
      "div",
      { display: "flex", alignItems: "center" },
      h("div", {}, "skybotmint.web.id"),
      h("div", { margin: "0 14px", color: ORANGE }, "•"),
      h("div", { color: ORANGE }, "@SkymintsBOT"),
    ),
  ),
);

const res = new ImageResponse(tree, {
  width: 1200,
  height: 630,
  fonts: [
    { name: "Syne", data: font("Syne-ExtraBold.ttf"), weight: 800, style: "normal" },
    { name: "Jakarta", data: font("PlusJakartaSans-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Jakarta", data: font("PlusJakartaSans-Bold.ttf"), weight: 700, style: "normal" },
  ],
});
const raw = Buffer.from(await res.arrayBuffer());
// Palette PNG keeps the file small (crawler limits: X ≤ 5 MB, WhatsApp prefers < 600 KB).
const png = await sharp(raw).png({ palette: true, quality: 92, effort: 10, dither: 0.6 }).toBuffer();
const out = path.resolve(process.argv[2] ?? path.join(web, "public", "og.png"));
fs.writeFileSync(out, png);
const meta = await sharp(png).metadata();
console.log(`wrote ${out} (${meta.width}×${meta.height}, ${(png.length / 1024).toFixed(0)} KB)`);
