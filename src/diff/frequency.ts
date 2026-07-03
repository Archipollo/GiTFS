// Diff-mode *frequency* overlay: how many scheduled trips/week each matched
// line gained or lost between feed A and feed B.
//
// Unlike the stop/segment diffs (identity-level: added/removed/moved), this
// is a continuous measure per canonical route, so it doesn't reuse
// `DIFF_COLOR`/`SEGMENT_COLOR`'s categorical palette. Colour encodes
// direction (more/less service), line width encodes the size of the change.
//
// One representative shape per route is used (the most-tripped one, from
// `fetchRouteRepresentativeShapes`) rather than every shape variant, so
// overlapping branches don't multiply-count or visually clutter the map.

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
  coords: [number, number][] | null;
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
  shapes: Map<string, [number, number][]>,
): [number, number][] | null {
  if (!rawIds) return null;
  for (const id of rawIds) {
    const c = shapes.get(id);
    if (c && c.length > 1) return c;
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

  const absDeltas = entries.map((e) => Math.abs(e.delta)).sort((a, b) => a - b);
  const maxAbsDelta = absDeltas.length > 0 ? absDeltas[absDeltas.length - 1] : 0;
  const p95 =
    absDeltas.length > 0
      ? absDeltas[Math.min(absDeltas.length - 1, Math.ceil(absDeltas.length * 0.95) - 1)]
      : 0;
  const scaleAbsDelta = p95 > 0 ? p95 : maxAbsDelta;

  return { feedA: diff.feedA, feedB: diff.feedB, entries, maxAbsDelta, scaleAbsDelta };
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

/** More service in B ("gain"). Blue — colourblind-safe, distinct from added/removed green/red. */
export const FREQUENCY_GAIN_COLOR = '#2563eb';
/** Less service in B ("loss"). Amber/orange — colourblind-safe pairing with the gain colour. */
export const FREQUENCY_LOSS_COLOR = '#ea580c';
/** ~No change. */
export const FREQUENCY_NEUTRAL_COLOR = '#94a3b8';

/** Line-width range in px (constant across zoom levels). */
export const FREQUENCY_MIN_WIDTH = 1.2;
export const FREQUENCY_MAX_WIDTH = 7;

// ---- GeoJSON ----------------------------------------------------------------

export function frequencyDiffToGeoJSON(result: FrequencyDiffResult): GeoJSON.FeatureCollection {
  // Normalized to [-1, 1] so the MapLibre paint expressions in MapView can use
  // a fixed domain instead of one re-derived from this particular diff's range.
  // Scaled by the robust p95 cap (see `scaleAbsDelta`), clamping outliers.
  const scale = result.scaleAbsDelta > 0 ? result.scaleAbsDelta : 1;
  const features: GeoJSON.Feature[] = result.entries.map((e) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: e.coords! },
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
    },
  }));
  return { type: 'FeatureCollection', features };
}
