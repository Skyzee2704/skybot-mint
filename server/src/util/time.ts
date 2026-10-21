// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ONE date/time formatter for SkyBOT (web, Mini App and Telegram bot all use this file).
 * Always unambiguous: weekday, day, spelled-out month, year, 24-hour time and an explicit UTC offset,
 * e.g. "Thu, 22 Oct 2026 · 21:00 (UTC+7) · in 23h 20m". Never numeric-only dates, never raw ISO.
 * Dependency-free so the browser bundle can import it.
 */

export type TimeInput = string | number | Date;

const toDate = (v: TimeInput): Date => (v instanceof Date ? v : new Date(v));

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The browser/runtime timezone (IANA), or "UTC". */
export function localTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

/** Offset of `timeZone` at `date` in minutes east of UTC (DST-aware). */
export function offsetMinutes(date: TimeInput, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(toDate(date));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -mins : mins;
}

/** "UTC", "UTC+7", "UTC+5:30", "UTC-4", "UTC+12:45". */
export function offsetLabel(date: TimeInput, timeZone: string): string {
  const off = offsetMinutes(date, timeZone);
  if (off === 0) return "UTC";
  const a = Math.abs(off);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${off < 0 ? "-" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "23h 20m", "2d 4h", "45s", "3m". Two most significant units. */
export function formatDuration(ms: number): string {
  let s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const units: [number, string][] = [
    [d, "d"],
    [h, "h"],
    [m, "m"],
    [s, "s"],
  ];
  const first = units.findIndex(([v]) => v > 0);
  if (first === -1) return "0s";
  return units
    .slice(first, first + 2)
    .filter(([v]) => v > 0)
    .map(([v, u]) => `${v}${u}`)
    .join(" ");
}

/** "in 23h 20m", "5m ago", "now" (within 30 s). */
export function formatRelative(when: TimeInput, now: TimeInput = Date.now()): string {
  const diff = toDate(when).getTime() - toDate(now).getTime();
  if (Math.abs(diff) < 30_000) return "now";
  return diff > 0 ? `in ${formatDuration(diff)}` : `${formatDuration(diff)} ago`;
}

export interface FormatOptions {
  /** IANA zone. Default: runtime zone (browser) — the bot passes the user's saved zone or "UTC". */
  timeZone?: string | null;
  /** Append " · in 2h 5m" / " · 5m ago". Default true. */
  relative?: boolean;
  /** Omit the year when it is the current year in that zone. Default false (always shown). */
  compactYear?: boolean;
  /** Show the offset label. Default true. */
  offset?: boolean;
  now?: TimeInput;
}

/** "Thu, 22 Oct 2026 · 21:00 (UTC+7) · in 23h 20m" */
export function formatDateTime(when: TimeInput, opts: FormatOptions = {}): string {
  const d = toDate(when);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const timeZone = isValidTimeZone(opts.timeZone ?? undefined)
    ? (opts.timeZone as string)
    : opts.timeZone === undefined
      ? localTimeZone()
      : "UTC";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const nowYear = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" }).format(toDate(opts.now ?? Date.now()));
  const year = opts.compactYear && parts.year === nowYear ? "" : ` ${parts.year}`;
  let out = `${parts.weekday}, ${parts.day} ${parts.month}${year} · ${parts.hour}:${parts.minute}`;
  if (opts.offset !== false) out += ` (${offsetLabel(d, timeZone)})`;
  if (opts.relative !== false) out += ` · ${formatRelative(d, opts.now)}`;
  return out;
}

/** Short form for tables: "22 Oct 2026, 21:00 (UTC+7)". */
export function formatShort(when: TimeInput, opts: Omit<FormatOptions, "relative"> = {}): string {
  return formatDateTime(when, { ...opts, relative: false })
    .replace(/^[A-Za-z]{3}, /, "")
    .replace(" · ", ", ");
}

/**
 * Wall-clock time typed by the user in `timeZone` ("2026-10-22T21:00" from <input type="datetime-local">)
 * → the real instant. DST-safe (re-checks the offset at the resulting instant).
 */
export function zonedWallTimeToDate(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let t = asUtc - offsetMinutes(asUtc, timeZone) * 60_000;
  t = asUtc - offsetMinutes(t, timeZone) * 60_000;
  return new Date(t);
}

/** Inverse of zonedWallTimeToDate: instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (for datetime-local values). */
export function toZonedInputValue(when: TimeInput, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(toDate(when))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Human name of a zone for labels: "Asia/Jakarta (UTC+7)". */
export function zoneLabel(timeZone: string, at: TimeInput = Date.now()): string {
  return `${timeZone.replace(/_/g, " ")} (${offsetLabel(at, timeZone)})`;
}
