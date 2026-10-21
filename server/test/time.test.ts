// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatShort,
  offsetLabel,
  toZonedInputValue,
  zonedWallTimeToDate,
} from "../src/util/time.js";

const T = "2026-10-22T14:00:00Z";
const now = Date.parse("2026-10-21T14:40:00Z");

describe("shared time formatter", () => {
  it("formats in the viewer's zone with weekday, spelled month, 24h, offset and relative time", () => {
    expect(formatDateTime(T, { timeZone: "Asia/Jakarta", now })).toBe("Thu, 22 Oct 2026 · 21:00 (UTC+7) · in 23h 20m");
    expect(formatDateTime(T, { timeZone: "UTC", now })).toBe("Thu, 22 Oct 2026 · 14:00 (UTC) · in 23h 20m");
    expect(formatDateTime(T, { timeZone: "America/Los_Angeles", now, relative: false })).toBe("Thu, 22 Oct 2026 · 07:00 (UTC-7)");
  });

  it("half-hour and 45-minute offsets", () => {
    expect(formatDateTime(T, { timeZone: "Asia/Kolkata", now, relative: false })).toBe("Thu, 22 Oct 2026 · 19:30 (UTC+5:30)");
    expect(offsetLabel(T, "Asia/Kathmandu")).toBe("UTC+5:45");
    expect(offsetLabel(T, "America/St_Johns")).toBe("UTC-2:30");
  });

  it("follows DST (Europe/London, America/New_York, Australia/Sydney)", () => {
    expect(offsetLabel("2026-07-01T12:00:00Z", "Europe/London")).toBe("UTC+1");
    expect(offsetLabel("2026-12-01T12:00:00Z", "Europe/London")).toBe("UTC");
    expect(offsetLabel("2026-07-01T12:00:00Z", "America/New_York")).toBe("UTC-4");
    expect(offsetLabel("2026-12-01T12:00:00Z", "America/New_York")).toBe("UTC-5");
    expect(offsetLabel("2026-01-15T12:00:00Z", "Australia/Sydney")).toBe("UTC+11");
    expect(offsetLabel("2026-07-15T12:00:00Z", "Australia/Sydney")).toBe("UTC+10");
  });

  it("never numeric-only dates or ISO", () => {
    const s = formatDateTime(T, { timeZone: "Europe/Berlin", now });
    expect(s).not.toMatch(/\d{1,2}\/\d{1,2}/);
    expect(s).not.toMatch(/T\d{2}:\d{2}/);
    expect(s).toMatch(/Oct/);
    expect(formatShort(T, { timeZone: "Asia/Jakarta" })).toBe("22 Oct 2026, 21:00 (UTC+7)");
  });

  it("falls back to UTC (labelled) for unknown zones", () => {
    expect(formatDateTime(T, { timeZone: "Not/AZone", now, relative: false })).toBe("Thu, 22 Oct 2026 · 14:00 (UTC)");
    expect(formatDateTime(T, { timeZone: null, now, relative: false })).toBe("Thu, 22 Oct 2026 · 14:00 (UTC)");
  });

  it("relative times and durations", () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelative(now + 10_000, now)).toBe("now");
    expect(formatRelative(now + 2 * 86400_000 + 4 * 3600_000, now)).toBe("in 2d 4h");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3 * 3600_000)).toBe("3h");
  });

  it("converts typed wall time in the user's zone to the right instant (incl. DST and +5:30)", () => {
    expect(zonedWallTimeToDate("2026-10-22T21:00", "Asia/Jakarta")!.getTime()).toBe(Date.parse(T));
    expect(zonedWallTimeToDate("2026-10-22T19:30", "Asia/Kolkata")!.getTime()).toBe(Date.parse(T));
    expect(zonedWallTimeToDate("2026-07-01T09:00", "America/New_York")!.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedWallTimeToDate("2026-12-01T09:00", "America/New_York")!.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(toZonedInputValue(T, "Asia/Kolkata")).toBe("2026-10-22T19:30");
    expect(zonedWallTimeToDate("garbage", "UTC")).toBeNull();
  });
});
