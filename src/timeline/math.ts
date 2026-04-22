// Timeline math — map a discrete "year" value onto the loaded feeds.
//
// GTFS releases are typically issued per schedule year (e.g. VOR 2024, 2025,
// 2026). The timeline UI uses integer years as its domain because the
// interesting network changes happen year-over-year, not day-by-day. We assign
// each feed a single representative year and let the user scrub between them.

import type { FeedMeta } from '../state/app-store';

/** One feed reduced to a single schedule year. */
export interface FeedYear {
  feedId: string;
  /** The representative year (integer, e.g. 2024). */
  year: number;
  /** Optional validity span (from calendar/feed_info) — for tooltips only. */
  startDate?: Date;
  endDate?: Date;
  /** True when no GTFS dates were available and we fell back to `loadedAt`. */
  synthetic: boolean;
}

const MS_PER_DAY = 86_400_000;

function dayToDate(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

/** Parse a GTFS YYYYMMDD string into epoch days (UTC). Returns null on failure. */
function parseGtfsDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
  const t = Date.UTC(y, m, d);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / MS_PER_DAY);
}

/**
 * Assign a single representative year to a feed.
 *
 *   1. If the feed declares a validity span, pick the year containing the
 *      span's midpoint. This handles the common case where a "2024" feed's
 *      service window spans Dec-2023 through Dec-2024 — the midpoint still
 *      lands squarely in 2024.
 *   2. Otherwise, fall back to the year the feed was ingested.
 */
export function yearOfFeed(meta: FeedMeta): FeedYear {
  const s = parseGtfsDate(meta.feedStartDate);
  const e = parseGtfsDate(meta.feedEndDate);
  if (s != null && e != null) {
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    const mid = Math.floor((lo + hi) / 2);
    return {
      feedId: meta.id,
      year: dayToDate(mid).getUTCFullYear(),
      startDate: dayToDate(lo),
      endDate: dayToDate(hi),
      synthetic: false,
    };
  }
  return {
    feedId: meta.id,
    year: new Date(meta.loadedAt).getUTCFullYear(),
    synthetic: true,
  };
}

/** Inclusive [minYear, maxYear] across all feeds, or null when none are loaded. */
export function yearRange(years: FeedYear[]): [number, number] | null {
  if (years.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const y of years) {
    if (y.year < lo) lo = y.year;
    if (y.year > hi) hi = y.year;
  }
  return [lo, hi];
}

/**
 * Pick the feed that represents a given year.
 *
 *   1. Exact-year match wins. When several feeds collapse to the same year
 *      (unusual but possible), the one loaded most recently wins — presumed
 *      to be the canonical one.
 *   2. Otherwise the feed whose year is closest; ties break to the later
 *      feed so scrubbing into a gap favours the newer schedule.
 */
export function pickFeedForYear(
  years: FeedYear[],
  year: number,
  feeds: Record<string, FeedMeta>,
): FeedYear | null {
  if (years.length === 0) return null;

  const loadedAt = (y: FeedYear) => feeds[y.feedId]?.loadedAt ?? 0;

  let exact: FeedYear | null = null;
  for (const y of years) {
    if (y.year !== year) continue;
    if (!exact || loadedAt(y) > loadedAt(exact)) exact = y;
  }
  if (exact) return exact;

  let best: FeedYear | null = null;
  let bestDist = Infinity;
  for (const y of years) {
    const dist = Math.abs(y.year - year);
    if (dist < bestDist || (dist === bestDist && best && y.year > best.year)) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

/** Convenience: list of years covered by the slider, inclusive. */
export function yearsInRange(range: [number, number] | null): number[] {
  if (!range) return [];
  const [lo, hi] = range;
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

// ---- display helpers ---------------------------------------------------
//
// Keep a single source of truth for how feeds are labelled so the timeline
// slider, feeds list, inspector and diff views never disagree about "what
// year is this?". The user-visible year always comes from `yearOfFeed`
// (midpoint-of-validity), never from an incidental substring of the
// filename or the raw feed_start_date.

/** Format a GTFS `YYYYMMDD` string as `YYYY-MM-DD`; returns `null` if unparseable. */
export function formatGtfsDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Strip a trailing ` (YYYY)` suffix from a label so callers can render the year separately. */
export function stripYearSuffix(label: string): string {
  return label.replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

/** Filename stem without `.zip`, with any trailing ` (YYYY)` suffix removed. */
export function cleanFeedStem(sourceName: string): string {
  const stem = sourceName.replace(/\.zip$/i, '');
  return stripYearSuffix(stem);
}

/**
 * Canonical feed label: `stem (YYYY)` where `YYYY` is the representative year
 * of the feed's validity span (midpoint), falling back to the ingest year.
 * This MUST agree with `yearOfFeed(meta).year`; the ingest pipeline and the
 * rehydrate pipeline both call through here so the label never drifts from
 * the timeline.
 */
export function buildFeedLabel(
  sourceName: string,
  feedStartDate: string | undefined,
  feedEndDate: string | undefined,
  loadedAt: number,
): string {
  const stem = cleanFeedStem(sourceName);
  const year = yearOfFeed({
    id: '',
    label: '',
    sourceName,
    loadedAt,
    feedStartDate,
    feedEndDate,
  }).year;
  return `${stem} (${year})`;
}
