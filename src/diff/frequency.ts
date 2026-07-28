// Diff-mode *frequency* overlay: how many scheduled trips/week each matched
// line gained or lost between feed A and feed B.
//
// Unlike the stop/segment diffs (identity-level: added/removed/moved), this
// is a continuous measure per canonical route, so it doesn't reuse
// `DIFF_COLOR`/`SEGMENT_COLOR`'s categorical palette. Colour encodes
// direction (more/less service), line width encodes the size of the change.
//
// All shape variants for a route (branches, loops, direction-specific
// geometry) are drawn together as one multi-line feature per route, from
// `fetchRouteRepresentativeShapes`, so the overlay covers the route's full
// extent instead of only its single most-tripped shape.

import type { DiffResult, RouteDiffEntry, RouteStatus } from './engine';
import type { Mode } from '../gtfs/modes';
import { fetchRouteWeeklyTrips, fetchRouteRepresentativeShapes } from '../gtfs/queries';

export interface RouteFrequencyEntry {
  canonicalId: string;
  shortName: string;
  longName: string;
  mode: Mode;
  routeStatus: RouteStatus;
  tripsPerWeekA: number;
  tripsPerWeekB: number;
  delta: number;
  /** One or more shape variants (branches/loops) making up the route's full extent. */
  coords: [number, number][][] | null;
}

export interface FrequencyDiffResult {
  feedA: string;
  feedB: string;
  entries: RouteFrequencyEntry[];
  /** Largest |delta| across all entries (informational; shown in the legend). */
  maxAbsDelta: number;
  /**
   * |delta| at which colour and width max out: the 95th-percentile |delta|,
   * not the maximum. One outlier route (say +5000 trips/week) would otherwise
   * stretch a max-based scale so far that every other line renders grey and
   * thin. Deltas beyond it clamp to full intensity; the legend labels the
   * ends "≤/≥" when that happens.
   */
  scaleAbsDelta: number;
}

function sumFor(rawIds: readonly string[] | undefined, trips: Map<string, number>): number {
  if (!rawIds) return 0;
  let total = 0;
  for (const id of rawIds) total += trips.get(id) ?? 0;
  return total;
}

function coordsFor(
  rawIds: readonly string[] | undefined,
  shapes: Map<string, [number, number][][]>,
): [number, number][][] | null {
  if (!rawIds) return null;
  for (const id of rawIds) {
    const c = shapes.get(id);
    if (c && c.length > 0) return c;
  }
  return null;
}

async function computeFrequencyDiff(diff: DiffResult): Promise<FrequencyDiffResult> {
  const routeIdsA: string[] = [];
  const routeIdsB: string[] = [];
  for (const e of diff.routes) {
    if (e.a) routeIdsA.push(...e.a.rawIds);
    if (e.b) routeIdsB.push(...e.b.rawIds);
  }

  const [tripsA, tripsB, shapesA, shapesB] = await Promise.all([
    fetchRouteWeeklyTrips(diff.feedA, routeIdsA),
    fetchRouteWeeklyTrips(diff.feedB, routeIdsB),
    fetchRouteRepresentativeShapes(diff.feedA, routeIdsA),
    fetchRouteRepresentativeShapes(diff.feedB, routeIdsB),
  ]);

  const entries: RouteFrequencyEntry[] = [];
  for (const e of diff.routes as RouteDiffEntry[]) {
    const tripsPerWeekA = sumFor(e.a?.rawIds, tripsA);
    const tripsPerWeekB = sumFor(e.b?.rawIds, tripsB);
    const delta = tripsPerWeekB - tripsPerWeekA;
    const coords = coordsFor(e.b?.rawIds, shapesB) ?? coordsFor(e.a?.rawIds, shapesA);
    if (!coords) continue; // nothing to draw
    entries.push({
      canonicalId: e.canonicalId,
      shortName: e.canonical.shortName,
      longName: e.canonical.longName,
      mode: e.canonical.mode,
      routeStatus: e.status,
      tripsPerWeekA,
      tripsPerWeekB,
      delta,
      coords,
    });
  }

  const { maxAbsDelta, scaleAbsDelta } = summarizeDeltas(entries);

  return { feedA: diff.feedA, feedB: diff.feedB, entries, maxAbsDelta, scaleAbsDelta };
}

function summarizeDeltas(entries: readonly RouteFrequencyEntry[]): { maxAbsDelta: number; scaleAbsDelta: number } {
  const absDeltas = entries.map((e) => Math.abs(e.delta)).sort((a, b) => a - b);
  const maxAbsDelta = absDeltas.length > 0 ? absDeltas[absDeltas.length - 1] : 0;
  const p95 =
    absDeltas.length > 0
      ? absDeltas[Math.min(absDeltas.length - 1, Math.ceil(absDeltas.length * 0.95) - 1)]
      : 0;
  const scaleAbsDelta = p95 > 0 ? p95 : maxAbsDelta;
  return { maxAbsDelta, scaleAbsDelta };
}

/**
 * Added/removed routes have no counterpart on one side, so their delta is
 * the full trips/week figure (a 100% swing) rather than a service-level
 * change — left unfiltered, one such route can stretch `scaleAbsDelta` so far
 * that every genuine frequency change on the network renders as a thin,
 * washed-out line. Excluding them (the default) re-scales the legend/colours
 * around real frequency changes only; the toggle lets the user opt back in.
 */
export function filterFrequencyDiff(result: FrequencyDiffResult, includeAddedRemoved: boolean): FrequencyDiffResult {
  if (includeAddedRemoved) return result;
  const entries = result.entries.filter((e) => e.routeStatus !== 'added' && e.routeStatus !== 'removed');
  if (entries.length === result.entries.length) return result;
  const { maxAbsDelta, scaleAbsDelta } = summarizeDeltas(entries);
  return { feedA: result.feedA, feedB: result.feedB, entries, maxAbsDelta, scaleAbsDelta };
}

// ---- cache (per (feedA,feedB,builtAt) — mirrors service.ts's diff cache) --

const cache = new Map<string, Promise<FrequencyDiffResult>>();

function keyFor(diff: DiffResult): string {
  return `${diff.feedA}${diff.feedB}${diff.builtAt}`;
}

/** Cached per-diff frequency computation; recomputes when the diff itself changes. */
export function getOrComputeFrequencyDiff(diff: DiffResult): Promise<FrequencyDiffResult> {
  const key = keyFor(diff);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = computeFrequencyDiff(diff).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}

// ---- colour / width scale --------------------------------------------------

// Discrete 5-class diverging scale (rather than a continuous gradient) so a
// route's delta reads as one of five unambiguous buckets both on the map and
// in the legend: big loss / small loss / ~no change / small gain / big gain.
/** Large loss (|delta| beyond the outer break) — dark orange. */
export const FREQUENCY_BIG_LOSS_COLOR = '#c85200';
/** Small loss — light orange. */
export const FREQUENCY_SMALL_LOSS_COLOR = '#e48646';
/** ~No change (within the inner break of zero). Light neutral gray so a flat
 * route reads as neutral rather than as a tinted "small change" or a stark
 * 6th unrelated hue against the orange/blue ends. */
export const FREQUENCY_NEUTRAL_COLOR = '#9ca3af';
/** Small gain — light blue. */
export const FREQUENCY_SMALL_GAIN_COLOR = '#6b8ea4';
/** Large gain (|delta| beyond the outer break) — dark blue. */
export const FREQUENCY_BIG_GAIN_COLOR = '#366785';

/** Which fixed scale classifies a route's change: relative to its own
 * baseline (percent), or a flat trips/week amount shared by every route. */
export type FrequencyClassMode = 'relative' | 'absolute';

/**
 * Break points on `percent_delta` (delta as a fraction of `tripsPerWeekA`)
 * separating the 5 classes: < B0 = big loss, [B0,B1) = small loss,
 * [B1,B2] = neutral, (B2,B3] = small gain, > B3 = big gain. Fixed constants —
 * unlike the old percentile-scaled breaks, these never move when the entry
 * set changes (e.g. toggling "include added/removed lines").
 */
export const FREQUENCY_RELATIVE_CLASS_BREAKS: readonly [number, number, number, number] = [-0.5, -0.15, 0.15, 0.5];

/**
 * Break points on raw `delta` (trips/week), same 5-class shape as above but
 * in absolute terms. A trunk line's several-hundred-trip swing and a small
 * feeder's few-trip swing are judged on the same fixed scale here — use the
 * relative breaks instead when comparing routes of very different size.
 */
export const FREQUENCY_ABSOLUTE_CLASS_BREAKS: readonly [number, number, number, number] = [-50, -10, 10, 50];

/** Line-width range in px, keyed to zoom (not delta magnitude — colour alone
 * encodes the change). Matches the weight of the other diff line layers. */
export const FREQUENCY_MIN_WIDTH = 1.4;
export const FREQUENCY_MAX_WIDTH = 3.4;

// ---- GeoJSON ----------------------------------------------------------------

export function frequencyDiffToGeoJSON(result: FrequencyDiffResult): GeoJSON.FeatureCollection {
  // Normalized to [-1, 1] so the MapLibre paint expressions in MapView can use
  // a fixed domain instead of one re-derived from this particular diff's range.
  // Scaled by the robust p95 cap (see `scaleAbsDelta`), clamping outliers.
  const scale = result.scaleAbsDelta > 0 ? result.scaleAbsDelta : 1;
  const features: GeoJSON.Feature[] = result.entries.map((e) => {
    // Removed routes (tripsPerWeekB === 0) fall out to exactly -1 (past the
    // bottom break); added routes (tripsPerWeekA === 0) have no baseline to
    // divide by, so they're pinned past the top break regardless of size.
    const percentDelta =
      e.tripsPerWeekA > 0 ? e.delta / e.tripsPerWeekA : e.tripsPerWeekB > 0 ? Number.POSITIVE_INFINITY : 0;
    return {
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: e.coords! },
      properties: {
        canonicalId: e.canonicalId,
        shortName: e.shortName,
        longName: e.longName,
        mode: e.mode,
        route_status: e.routeStatus,
        trips_a: e.tripsPerWeekA,
        trips_b: e.tripsPerWeekB,
        delta: e.delta,
        delta_norm: Math.max(-1, Math.min(1, e.delta / scale)),
        percent_delta: Math.max(-1, Math.min(3, percentDelta)),
      },
    };
  });
  return { type: 'FeatureCollection', features };
}
