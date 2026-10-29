// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { displayStages, fmtInt, formatDropSummary, stageTimeLine } from "../src/bot/format.js";
import { checkCallbackData, parseCheckCallback } from "../src/bot/telegram.js";

const now = Date.parse("2026-10-22T05:00:00Z");
const stage = (name: string, type: string, start: string | null, extra: any = {}) => ({
  name,
  type,
  priceWei: "0",
  start,
  end: null,
  maxPerWallet: null,
  status: "upcoming",
  source: "opensea",
  ...extra,
});
const lilTrenchers: any = {
  name: "Lil Trenchers",
  symbol: "lil",
  kind: "seadrop",
  standard: "erc721",
  slug: "lil-trenchers-eth",
  opensea: { url: null },
  chain: { key: "ethereum", chainId: 1, name: "Ethereum", nativeSymbol: "ETH", explorer: "https://etherscan.io" },
  contract: "0xd80f6a4b4a3e2c1d0b9a8f7e6d5c4b3a2f1e3a08",
  supply: { total: "0", max: "3333", remaining: "3333" },
  warnings: [],
  stages: [
    stage("Public Sale", "public", "2026-10-31T13:00:00Z", { priceWei: "4200000000000000", maxPerWallet: 5 }),
    stage("GTD Phase", "signed", "2026-10-31T01:00:00Z", { maxPerWallet: 2 }),
    stage("Founders Phase", "signed", "2026-10-30T21:00:00Z", { maxPerWallet: 25 }),
    stage("Trenchettes Phase", "signed", "2026-10-30T14:00:00Z", { maxPerWallet: 3333 }),
  ],
};

describe("drop summary (/mint, plain links)", () => {
  it("multi-phase drop: compact, phone-friendly, soonest first, Public last", () => {
    expect(formatDropSummary(lilTrenchers, "Asia/Makassar", now)).toBe(
      [
        "<b>Lil Trenchers</b> · Ethereum",
        '<code>0xD80f…3a08</code> · <a href="https://opensea.io/collection/lil-trenchers-eth">OpenSea</a> · <a href="https://etherscan.io/address/0xD80f6a4B4A3e2C1D0b9A8F7e6d5C4b3A2f1e3a08">Explorer</a>',
        "SeaDrop · ERC-721 · Supply 0 / 3,333",
        "",
        "<b>Trenchettes Phase</b> · Free · max 3,333",
        "🕒 Fri, 30 Oct · 22:00 (UTC+8) · in 8d 9h",
        "",
        "<b>Founders Phase</b> · Free · max 25",
        "🕒 Sat, 31 Oct · 05:00 (UTC+8) · in 8d 16h",
        "",
        "<b>GTD Phase</b> · Free · max 2",
        "🕒 Sat, 31 Oct · 09:00 (UTC+8) · in 8d 20h",
        "",
        "<b>Public</b> · 0.0042 ETH · max 5",
        "🕒 Sat, 31 Oct · 21:00 (UTC+8) · in 9d 8h",
        "",
        "<i>Times in Asia/Makassar.</i>",
      ].join("\n"),
    );
  });

  it("live, ended, next-year and unknown-time stages", () => {
    const tz = "Asia/Makassar";
    expect(stageTimeLine({ status: "active", start: "2026-10-21T00:00:00Z", end: "2026-10-22T07:00:00Z" }, tz, now)).toBe(
      "🟢 Live · ends Thu, 22 Oct · 15:00 (UTC+8) · in 2h",
    );
    expect(stageTimeLine({ status: "active", start: null, end: null }, tz, now)).toBe("🟢 Live now");
    expect(stageTimeLine({ status: "ended", start: null, end: null }, tz, now)).toBe("Ended");
    expect(stageTimeLine({ status: "upcoming", start: "2027-01-05T02:00:00Z", end: null }, tz, now)).toMatch(
      /^🕒 Tue, 5 Jan 2027 · 10:00 \(UTC\+8\)/,
    );
    expect(stageTimeLine({ status: "unknown", start: null, end: null }, tz, now)).toBe("🕒 Time not announced");
    const order = displayStages([
      stage("Old", "signed", "2026-10-01T00:00:00Z", { status: "ended" }),
      stage("Public", "public", "2026-10-21T00:00:00Z", { status: "active" }),
      stage("WL", "signed", "2026-10-23T00:00:00Z"),
    ] as any).map((s) => s.name);
    expect(order).toEqual(["WL", "Public", "Old"]);
  });

  it("numbers, escaping, no year in the current year, UTC fallback", () => {
    expect(fmtInt("1234567")).toBe("1,234,567");
    expect(fmtInt(null)).toBe("?");
    const msg = formatDropSummary({ ...lilTrenchers, name: "A <b>&", stages: [] }, null, now);
    expect(msg).toContain("<b>A &lt;b&gt;&amp;</b> · Ethereum");
    expect(msg).toContain("No mint stages found yet.");
    expect(msg).toContain("Times in UTC. Open SkyBOT once");
    expect(formatDropSummary(lilTrenchers, "Asia/Makassar", now)).not.toMatch(/2026|Open the dashboard|\n• /);
  });

  it("Check eligibility callback fits Telegram's 64-byte limit and round-trips", () => {
    expect(parseCheckCallback(checkCallbackData(lilTrenchers))).toEqual({ input: "lil-trenchers-eth" });
    const noSlug = { ...lilTrenchers, slug: null };
    const d = checkCallbackData(noSlug);
    expect(d.length).toBeLessThanOrEqual(64);
    expect(parseCheckCallback(d)).toEqual({ input: lilTrenchers.contract, chain: "ethereum" });
    const long = { ...lilTrenchers, slug: "x".repeat(70), chain: { ...lilTrenchers.chain, key: "robinhood" } };
    expect(Buffer.byteLength(checkCallbackData(long))).toBeLessThanOrEqual(64);
    expect(parseCheckCallback("chk:a:base:0x123")).toBeNull();
  });
});
