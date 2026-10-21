// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { formatCheck, parseCheckArgs, splitMessage } from "../src/bot/check.js";

const addr = "0x03994a44f09c415e72443d2f09d2170c8b28bf97";

describe("/check parsing", () => {
  it("accepts links, addresses, chain-qualified addresses and slugs", () => {
    expect(parseCheckArgs("/check https://opensea.io/collection/kabuki-killers")).toEqual({
      input: "https://opensea.io/collection/kabuki-killers",
    });
    expect(parseCheckArgs(`/check ${addr}`)).toEqual({ input: addr });
    expect(parseCheckArgs(`/check base:${addr}`)).toEqual({ input: addr, chain: "base" });
    expect(parseCheckArgs(`/check ${addr} base`)).toEqual({ input: addr, chain: "base" });
    expect(parseCheckArgs(`/check@MyTradeSkyBOT ethereum ${addr}`)).toEqual({ input: addr, chain: "ethereum" });
    expect(parseCheckArgs("/check kabuki-killers")).toEqual({ input: "kabuki-killers" });
  });
  it("rejects empty / junk input", () => {
    expect(parseCheckArgs("/check")).toBeNull();
    expect(parseCheckArgs("/check    ")).toBeNull();
    expect(parseCheckArgs("/check <script>alert(1)</script>!!")).toBeNull();
    expect(parseCheckArgs("/check " + "a".repeat(400))).toBeNull();
  });
});

const target: any = {
  name: "Kabuki <Killers>",
  chain: { key: "ethereum", name: "Ethereum", nativeSymbol: "ETH" },
  contract: addr,
  supply: { total: "0", max: "211" },
  stages: [
    {
      name: "GTD",
      type: "signed",
      priceWei: "750000000000000",
      start: "2026-10-22T14:00:00Z",
      end: null,
      maxPerWallet: 2,
      status: "upcoming",
    },
    { name: "Public", type: "public", priceWei: "0", start: "2026-10-23T14:00:00Z", end: null, maxPerWallet: null, status: "upcoming" },
  ],
};
const row = (label: string, access: any, extra: any = {}) => ({
  walletId: label,
  label,
  address: "0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0",
  access,
  reasons: [],
  simulation: null,
  stages: null,
  needsOpenSeaLogin: false,
  ...extra,
});

describe("/check formatting", () => {
  const now = Date.parse("2026-10-21T14:40:00Z");
  it("summary line, human times in the user's zone, per-wallet verdicts, escaped HTML", () => {
    const [msg] = formatCheck({
      target,
      rows: [
        row("Main", { status: "yes", source: "x", detail: 'eligible for "GTD"' }),
        row("Alt", { status: "no", source: "x", detail: 'not eligible for "GTD"' }),
        row("New", { status: "unknown", source: "x" }, { needsOpenSeaLogin: true }),
      ] as any,
      targetStage: { label: "GTD", start: "2026-10-22T14:00:00Z", active: false },
      timeZone: "Asia/Kolkata",
      now,
    });
    expect(msg.split("\n")[0]).toBe("<b>1 of 3 wallets eligible for GTD</b> · 1 unknown");
    expect(msg).toContain("Kabuki &lt;Killers&gt;");
    expect(msg).toContain("starts Thu, 22 Oct 2026 · 19:30 (UTC+5:30) · in 23h 20m");
    expect(msg).toContain("Free");
    expect(msg).toContain("max 2/wallet");
    expect(msg).toContain("✅ <b>Main</b> <code>0x668B…27A0</code> · Eligible");
    expect(msg).toContain("❌ <b>Alt</b>");
    expect(msg).toContain("Unknown — open app once to verify");
    expect(msg).toContain("Open in SkyBOT");
    expect(msg).toContain("Times shown in Asia/Kolkata.");
    expect(msg).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it("labels UTC when the user's timezone is unknown", () => {
    const [msg] = formatCheck({ target, rows: [], targetStage: null, timeZone: null, now });
    expect(msg).toContain("(UTC)");
    expect(msg).toContain("Times shown in UTC. Open SkyBOT once");
  });
  it("splits long messages on line boundaries under Telegram's limit", () => {
    const parts = splitMessage(Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> ${"x".repeat(40)}`));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3900);
      expect(p.split("<b>").length).toBe(p.split("</b>").length);
    }
  });
});

describe("stage order", () => {
  it("live first, then upcoming soonest first, then ended — in /check output too", async () => {
    const { sortStages } = await import("../src/core/resolver/stageOrder.js");
    const st = [
      { name: "Public (on-chain)", status: "upcoming", start: "2026-10-23T14:00:00Z" },
      { name: "Old", status: "ended", start: "2026-10-01T00:00:00Z" },
      { name: "FCFS", status: "upcoming", start: "2026-10-22T16:00:00Z" },
      { name: "GTD", status: "upcoming", start: "2026-10-22T15:00:00Z" },
      { name: "Live", status: "active", start: "2026-10-20T00:00:00Z" },
    ];
    expect(sortStages(st).map((s) => s.name)).toEqual(["Live", "GTD", "FCFS", "Public (on-chain)", "Old"]);
    const t2 = {
      ...target,
      stages: st.map((s) => ({ ...s, type: "public", priceWei: "0", end: null, maxPerWallet: null })),
    };
    const [msg] = formatCheck({ target: t2, rows: [], targetStage: null, timeZone: "UTC", now: Date.parse("2026-10-21T14:40:00Z") });
    const pos = ["<b>Live</b>", "<b>GTD</b>", "<b>FCFS</b>", "<b>Public (on-chain)</b>", "<b>Old</b>"].map((x) => msg.indexOf(x));
    expect(pos.every((p, i) => p > 0 && (i === 0 || p > pos[i - 1]!))).toBe(true);
  });
});
