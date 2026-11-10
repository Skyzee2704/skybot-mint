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
    expect(parseCheckArgs(`/check@SkymintsBOT ethereum ${addr}`)).toEqual({ input: addr, chain: "ethereum" });
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
  it("per-phase headline and sections, human times in the user's zone, Public on one line, escaped HTML", () => {
    const [msg] = formatCheck({
      target,
      rows: [
        row("Main", { status: "yes", source: "x" }, { stages: [{ label: "GTD", type: "signed", eligible: true, maxPerWallet: 2 }] }),
        row("Alt", { status: "no", source: "x", detail: 'not eligible for "GTD"' }),
        row("New", { status: "unknown", source: "x" }, { needsOpenSeaLogin: true }),
      ] as any,
      targetStage: { label: "GTD", start: "2026-10-22T14:00:00Z", active: false },
      timeZone: "Asia/Kolkata",
      now,
    });
    expect(msg.split("\n")[0]).toBe("<b>GTD: 1/3 eligible, 1 unknown</b>");
    expect(msg).toContain("Kabuki &lt;Killers&gt;");
    expect(msg).toContain("<b>GTD</b> · 0.00075 ETH · max 2\n🕒 Thu, 22 Oct · 19:30 (UTC+5:30) · in 23h 20m\n✅ Main");
    expect(msg).toContain("<b>Kabuki &lt;Killers&gt;</b> · Ethereum\n<code>0x0399…bF97</code>");
    expect(msg).toContain("✅ Main <code>0x668B…27A0</code> (max 2)");
    expect(msg).toContain("❌ 1 not eligible: Alt");
    expect(msg).toContain("❔ 1 belum terverifikasi — lihat alasan di bawah: New");
    expect(msg).toContain("❔ Belum terverifikasi: New. SkyBOT belum bisa menandatangani dompet ini ke OpenSea.");
    expect(msg).not.toContain("Open SkyBOT once and future checks");
    // Public: one summary line only, no wallet section; stage details never repeated.
    expect(msg).toContain("<b>Other stages</b>\n\n<b>Public</b> · Free\n🕒 Fri, 23 Oct · 19:30 (UTC+5:30) · in 1d 23h");
    expect(msg.match(/Thu, 22 Oct · 19:30/g)?.length).toBe(1);
    expect(msg).not.toMatch(/GTD: (yes|no)|Public stage: \?|not eligible for|Wallets \(/);
    expect(msg).toContain("<i>Times in Asia/Kolkata. Read-only check, nothing was sent.</i>");
    expect(msg).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it("many phases × many wallets: every allowlist phase gets a compact section, soonest first", () => {
    const phases = ["Trenchettes Phase", "Founders Phase", "GTD Phase", "FCFS Phase"];
    const t5 = {
      ...target,
      stages: [
        {
          name: "Public Mint",
          type: "public",
          priceWei: "1",
          start: "2026-10-23T18:00:00Z",
          end: null,
          maxPerWallet: 5,
          status: "upcoming",
        },
        ...phases
          .map((name, k) => ({
            name,
            type: "signed",
            priceWei: "3000000000000000",
            start: `2026-10-22T1${4 + k}:00:00Z`,
            end: null,
            maxPerWallet: 2,
            status: "upcoming",
          }))
          .reverse(),
      ],
    };
    const rows = Array.from({ length: 25 }, (_, n) =>
      row(
        `wallet-${n + 1}`,
        { status: n === 24 ? "unknown" : "no", source: "x" },
        {
          walletId: `w${n}`,
          needsOpenSeaLogin: n === 24,
          stages:
            n === 24
              ? null
              : phases.map((label, k) => ({
                  label,
                  type: "signed",
                  eligible: k === 2 ? n < 2 : k === 0 ? false : n % 5 === 0,
                  maxPerWallet: 2,
                })),
        },
      ),
    );
    const parts = formatCheck({
      target: t5,
      rows: rows as any,
      targetStage: { label: "Trenchettes Phase", start: null, active: false },
      timeZone: "UTC",
      now,
    });
    const msg = parts.join("\n");
    expect(msg.split("\n")[0]).toBe(
      "<b>Trenchettes Phase: 0/25 eligible, 1 unknown · Founders Phase: 5/25 eligible, 1 unknown · GTD Phase: 2/25 eligible, 1 unknown · FCFS Phase: 5/25 eligible, 1 unknown</b>",
    );
    const pos = phases.map((p) => msg.indexOf(`<b>${p}</b> · `));
    expect(pos.every((p, i) => p > 0 && (i === 0 || p > pos[i - 1]!))).toBe(true);
    const gtd = msg.slice(pos[2], pos[3]);
    expect(gtd).toContain("✅ wallet-1 <code>0x668B…27A0</code> (max 2)");
    expect(gtd).toContain("✅ wallet-2 ");
    expect(gtd).toContain("❌ 22 not eligible\n");
    expect(gtd).toContain("❔ 1 belum terverifikasi — lihat alasan di bawah: wallet-25");
    expect(msg.slice(pos[0], pos[1])).toContain("❌ 24 not eligible");
    expect(msg).not.toMatch(/<b>Public Mint<\/b> · \d+\/25/);
    expect(msg).toContain("\n<b>Public</b> · 0.000000000000000001 ETH · max 5\n🕒 ");
    // Compact: 25 wallets × 4 phases still fits well inside one Telegram message.
    expect(parts.length).toBe(1);
    expect(msg.length).toBeLessThan(2500);
  });
  it("no wallet eligible in a phase: one line", () => {
    const [msg] = formatCheck({
      target,
      rows: [row("a", { status: "no", source: "x" }, { walletId: "a" }), row("b", { status: "no", source: "x" }, { walletId: "b" })] as any,
      targetStage: { label: "GTD", start: null, active: false },
      timeZone: "UTC",
      now,
    });
    expect(msg).toContain("❌ None of your 2 wallets are eligible");
  });
  it("overflow splits between phase sections, never inside one", async () => {
    const { splitBlocks } = await import("../src/bot/check.js");
    const blocks = Array.from({ length: 30 }, (_, k) => [
      "",
      `<b>Phase ${k}</b>`,
      ...Array.from({ length: 12 }, (_, i) => `✅ w${i} ${"x".repeat(20)}`),
    ]);
    const parts = splitBlocks(blocks, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect(p.startsWith("<b>Phase ")).toBe(true);
    }
  });
  it("labels UTC when the user's timezone is unknown", () => {
    const [msg] = formatCheck({ target, rows: [], targetStage: null, timeZone: null, now });
    expect(msg).toContain("(UTC)");
    expect(msg).toContain("Times in UTC. Open SkyBOT once to use your own time zone.");
  });
  it("splits long messages on line boundaries under Telegram's limit", () => {
    const parts = splitMessage(Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> ${"x".repeat(40)}`));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3900);
      expect(p.split("<b>").length).toBe(p.split("</b>").length);
    }
  });

  it("Kalos ended allowlist + live public uses stage lines, not the flat wallet list", () => {
    const at = Date.parse("2026-11-09T18:00:00Z");
    const t = {
      ...target,
      name: "Bitizens",
      dropSource: "kalos",
      chain: { key: "elysium", name: "Elysium", nativeSymbol: "HYPE" },
      contract: "0xA3aE6dBF763Aa58C41f3a3Ae9746eA13e357b722",
      kind: "seadrop",
      standard: "erc721",
      supply: { total: "309", max: "4000" },
      stages: [
        {
          name: "WL phase",
          type: "allowlist",
          source: "kalos",
          priceWei: "12000000000000000",
          start: "2026-11-09T08:00:00Z",
          end: "2026-11-09T17:00:00Z",
          maxPerWallet: 1,
          status: "ended",
        },
        {
          name: "Public",
          type: "public",
          source: "kalos",
          priceWei: "22000000000000000",
          start: "2026-11-09T17:00:00Z",
          end: "2026-11-10T11:00:00Z",
          maxPerWallet: 2,
          status: "active",
        },
      ],
    };
    const low = (label: string) =>
      row(
        label,
        { status: "public", source: "Kalos" },
        {
          reasons: ["insufficient balance (need ~0.044 HYPE, have 0.0000079 HYPE)"],
          mintedSoFar: 0,
          stages: [{ label: "Public", type: "public", eligible: true, maxPerWallet: 2 }],
        },
      );
    const [msg] = formatCheck({
      target: t,
      rows: [low("wallet-2"), low("Wallet 3")] as any,
      targetStage: { label: "Public", type: "public", start: "2026-11-09T17:00:00Z", active: true },
      timeZone: "Asia/Makassar",
      now: at,
    });
    expect(msg).not.toContain("<b>Wallets</b>");
    expect(msg).not.toContain("0 of 2 wallets eligible");
    expect(msg).not.toMatch(/not eligible \(insufficient/);
    expect(msg).toContain("<b>Bitizens</b> · Elysium");
    expect(msg).toContain("Kalos · ERC-721");
    expect(msg).toContain("<b>Public</b> · 0.022 HYPE · max 2");
    expect(msg).toContain("🟢 Live");
    expect(msg).toContain("<b>WL phase</b> · 0.012 HYPE · max 1");
    expect(msg).toContain("Ended");
    expect(msg).toContain("⚠️ 2 not enough HYPE for price + gas");
    expect(msg).toContain("<i>Times in Asia/Makassar. Read-only check, nothing was sent.</i>");
  });

  it("Kalos upcoming allowlist lists eligible wallets with remaining want", () => {
    const at = Date.parse("2026-11-09T18:00:00Z");
    const t = {
      ...target,
      name: "Elyant",
      dropSource: "kalos",
      chain: { key: "elysium", name: "Elysium", nativeSymbol: "HYPE" },
      kind: "seadrop",
      standard: "erc721",
      supply: { total: "10", max: "1111" },
      stages: [
        {
          name: "Colony",
          type: "allowlist",
          source: "kalos",
          priceWei: "8000000000000000",
          start: "2026-11-09T20:00:00Z",
          end: "2026-11-10T20:00:00Z",
          maxPerWallet: 2,
          status: "upcoming",
        },
        {
          name: "Public",
          type: "public",
          source: "kalos",
          priceWei: "8000000000000000",
          start: "2026-11-10T20:00:00Z",
          end: null,
          maxPerWallet: 3,
          status: "upcoming",
        },
      ],
    };
    const mk = (label: string, eligible: boolean, minted: number) =>
      row(
        label,
        { status: eligible ? "yes" : "no", source: "Kalos" },
        {
          mintedSoFar: minted,
          reasons: eligible ? ["insufficient balance (need ~0.02 HYPE, have 0 HYPE)"] : ["Colony: not on list"],
          stages: [{ label: "Colony", type: "allowlist", eligible, maxPerWallet: 2 }],
        },
      );
    const [msg] = formatCheck({
      target: t,
      rows: [mk("wallet-2", true, 1), mk("Wallet 3", true, 0), mk("wallet-4", false, 0)] as any,
      targetStage: { label: "Colony", type: "allowlist", start: "2026-11-09T20:00:00Z", active: false },
      timeZone: "Asia/Makassar",
      now: at,
    });
    expect(msg.split("\n")[0]).toBe("<b>Colony: 2/3 eligible</b>");
    expect(msg).toContain("✅ wallet-2 <code>0x668B…27A0</code> (max 1)");
    expect(msg).toContain("✅ Wallet 3 <code>0x668B…27A0</code> (max 2)");
    expect(msg).toContain("❌ 1 not eligible");
    expect(msg).toContain("⚠️ 2 not enough HYPE for price + gas");
    expect(msg).not.toMatch(/not eligible \(insufficient/);
    expect(msg).toContain("<b>Other stages</b>");
    expect(msg).toContain("<b>Public</b> · 0.008 HYPE · max 3");
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
      stages: st.map((s) => ({ ...s, type: /public/i.test(s.name) ? "public" : "signed", priceWei: "0", end: null, maxPerWallet: null })),
    };
    const [msg] = formatCheck({ target: t2, rows: [], targetStage: null, timeZone: "UTC", now: Date.parse("2026-10-21T14:40:00Z") });
    // Display order: live, allowlist phases soonest first, Public after them, ended last.
    const pos = ["<b>Live</b>", "<b>GTD</b>", "<b>FCFS</b>", "<b>Public</b>", "<b>Old</b>"].map((x) => msg.indexOf(x));
    expect(msg).toContain("<b>Live</b> · Free\n🟢 Live now");
    expect(msg).toContain("<b>Old</b> · Free\nEnded");
    expect(pos.every((p, i) => p > 0 && (i === 0 || p > pos[i - 1]!))).toBe(true);
  });
});
