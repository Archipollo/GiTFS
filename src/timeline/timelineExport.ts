// Per-feed-year summary export for the Timeline view — one row per loaded
// feed (not per changed entity, unlike `exportGtfsDiffV1`), meant for a
// thesis-style table showing how the network evolved release to release.

import { csvRow } from '../diff/gtfs-diff-export';
import { fetchFeedTotalWeeklyTrips } from '../gtfs/queries';
import { subscribeRegistry } from '../registry/registry';
import type { FeedMeta } from '../state/app-store';
import { formatGtfsDate, type FeedYear } from './math';

export interface TimelineYearRow {
  year: string;
  feedLabel: string;
  stopCount: number | null;
  routeCount: number | null;
  tripCount: number | null;
  serviceStart: string | null;
  serviceEnd: string | null;
  totalWeeklyTrips: number | null;
}

export function buildTimelineTrendRows(
  feedYears: FeedYear[],
  labels: string[],
  feeds: Record<string, FeedMeta>,
  weeklyTripsByFeed: Map<string, number> | null,
): TimelineYearRow[] {
  return feedYears.map((fy, i) => {
    const meta = feeds[fy.feedId];
    return {
      year: labels[i] ?? String(fy.year),
      feedLabel: meta?.label ?? fy.feedId,
      stopCount: meta?.stopCount ?? null,
      routeCount: meta?.routeCount ?? null,
      tripCount: meta?.tripCount ?? null,
      serviceStart: meta ? formatGtfsDate(meta.feedStartDate) : null,
      serviceEnd: meta ? formatGtfsDate(meta.feedEndDate) : null,
      totalWeeklyTrips: weeklyTripsByFeed?.get(fy.feedId) ?? null,
    };
  });
}

const HEADER = ['year', 'feed', 'stops', 'routes', 'trips', 'service_start', 'service_end', 'weekly_trips'];

export function timelineTrendRowsToCsv(rows: TimelineYearRow[]): string {
  const lines = [csvRow(HEADER)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.year,
        r.feedLabel,
        r.stopCount != null ? String(r.stopCount) : '',
        r.routeCount != null ? String(r.routeCount) : '',
        r.tripCount != null ? String(r.tripCount) : '',
        r.serviceStart ?? '',
        r.serviceEnd ?? '',
        r.totalWeeklyTrips != null ? String(r.totalWeeklyTrips) : '',
      ]),
    );
  }
  return lines.join('\n');
}

// ---- per-feed weekly-trips cache (O(N) feeds, not O(N²) pairs) ------------

const weeklyTripsCache = new Map<string, Promise<number>>();
let registrySubscribed = false;

function ensureCacheInvalidation() {
  if (registrySubscribed) return;
  registrySubscribed = true;
  subscribeRegistry(() => weeklyTripsCache.clear());
}

/** Cached total weekly trips per feed; recomputed once the registry rebuilds. */
export function getOrComputeFeedTotalWeeklyTrips(feedId: string): Promise<number> {
  ensureCacheInvalidation();
  const hit = weeklyTripsCache.get(feedId);
  if (hit) return hit;
  const p = fetchFeedTotalWeeklyTrips(feedId).catch((err) => {
    weeklyTripsCache.delete(feedId);
    throw err;
  });
  weeklyTripsCache.set(feedId, p);
  return p;
}

/** Fetch the weekly-trips figure for every feed-year, keyed by feed id. */
export async function fetchWeeklyTripsForFeedYears(feedYears: FeedYear[]): Promise<Map<string, number>> {
  const entries = await Promise.all(
    feedYears.map(async (fy) => [fy.feedId, await getOrComputeFeedTotalWeeklyTrips(fy.feedId)] as const),
  );
  return new Map(entries);
}

function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadTimelineTrendCsv(rows: TimelineYearRow[]): void {
  downloadBlob(timelineTrendRowsToCsv(rows), 'text/csv', `gitfs-timeline-stats-${new Date().toISOString().slice(0, 10)}.csv`);
}
