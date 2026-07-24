// Single-feed *absolute* frequency: trips/week per route, for the Analysis
// toolbox's Frequency mode when there's no diff pair to compare against
// (plain single-feed browsing, or scrubbing the timeline slider). Mirrors
// `src/diff/frequency.ts`'s diff-mode computation, but one-sided — no delta,
// so the color scale runs low→high instead of loss→gain, and there's only
// one feed's worth of queries to run.

import { fetchRouteWeeklyTrips, fetchRouteRepresentativeShapes } from './queries';

export interface RouteWeeklyFrequency {
  routeId: string;
  tripsPerWeek: number;
  /** One or more shape variants (branches/loops) making up the route's full extent. */
  coords: [number, number][][];
}

export interface FeedFrequencyResult {
  feedId: string;
  entries: RouteWeeklyFrequency[];
  /** Largest trips/week across all routes (informational; shown in the legend). */
  maxWeeklyTrips: number;
  /**
   * Trips/week at which color and width max out: the 95th-percentile value,
   * not the maximum, so one outlier route doesn't wash out every other line's
   * color range. Mirrors `scaleAbsDelta` in the diff-mode version.
   */
  scaleWeeklyTrips: number;
}

async function computeFeedFrequency(feedId: string, routeIds: string[]): Promise<FeedFrequencyResult> {
  const [trips, shapes] = await Promise.all([
    fetchRouteWeeklyTrips(feedId, routeIds),
    fetchRouteRepresentativeShapes(feedId, routeIds),
  ]);

  const entries: RouteWeeklyFrequency[] = [];
  for (const routeId of routeIds) {
    const coords = shapes.get(routeId);
    if (!coords || coords.length === 0) continue; // nothing to draw
    entries.push({ routeId, tripsPerWeek: trips.get(routeId) ?? 0, coords });
  }

  const values = entries.map((e) => e.tripsPerWeek).sort((a, b) => a - b);
  const maxWeeklyTrips = values.length > 0 ? values[values.length - 1] : 0;
  const p95 =
    values.length > 0
      ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]
      : 0;
  const scaleWeeklyTrips = p95 > 0 ? p95 : maxWeeklyTrips;

  return { feedId, entries, maxWeeklyTrips, scaleWeeklyTrips };
}

// ---- cache (per feedId — the route set for a feed is stable) --------------

const cache = new Map<string, Promise<FeedFrequencyResult>>();

/** Cached per-feed frequency computation. */
export function getOrComputeFeedFrequency(feedId: string, routeIds: string[]): Promise<FeedFrequencyResult> {
  const hit = cache.get(feedId);
  if (hit) return hit;
  const p = computeFeedFrequency(feedId, routeIds).catch((err) => {
    cache.delete(feedId);
    throw err;
  });
  cache.set(feedId, p);
  return p;
}

export function dropFeedFrequencyCache(feedId: string): void {
  cache.delete(feedId);
}

// ---- GeoJSON ----------------------------------------------------------------

export function feedFrequencyToGeoJSON(result: FeedFrequencyResult): GeoJSON.FeatureCollection {
  const scale = result.scaleWeeklyTrips > 0 ? result.scaleWeeklyTrips : 1;
  const features: GeoJSON.Feature[] = result.entries.map((e) => ({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: e.coords },
    properties: {
      route_id: e.routeId,
      trips_per_week: e.tripsPerWeek,
      trips_norm: Math.max(0, Math.min(1, e.tripsPerWeek / scale)),
    },
  }));
  return { type: 'FeatureCollection', features };
}

// ---- colour / width scale --------------------------------------------------

// Discrete 5-class scale (rather than a continuous gradient), reusing the
// same orange/black/blue ramp as the diff-mode frequency overlay — mapped
// onto absolute magnitude (low → high) instead of signed delta (loss → gain)
// — so the two Frequency modes read as one feature.
/** Lowest quintile of trips/week — dark orange. */
export const FEED_FREQUENCY_LOWEST_COLOR = '#9a3412';
/** Second-lowest quintile — light orange. */
export const FEED_FREQUENCY_LOW_COLOR = '#fb923c';
/** Middle quintile — light neutral gray. */
export const FEED_FREQUENCY_MID_COLOR = '#9ca3af';
/** Second-highest quintile — light blue. */
export const FEED_FREQUENCY_HIGH_COLOR = '#60a5fa';
/** Highest quintile of trips/week — dark blue. */
export const FEED_FREQUENCY_HIGHEST_COLOR = '#1e3a8a';

/**
 * Break points on `trips_norm` ([0, 1], trips/week scaled by
 * `scaleWeeklyTrips`) separating the 5 equal-width classes.
 */
export const FEED_FREQUENCY_CLASS_BREAKS: readonly [number, number, number, number] = [0.2, 0.4, 0.6, 0.8];

export const FEED_FREQUENCY_MIN_WIDTH = 1.2;
export const FEED_FREQUENCY_MAX_WIDTH = 4;
