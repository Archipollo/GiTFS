// GeoJSON builders for diff-mode *stop* overlays.
//
// Stops are classified at the entity level (added / removed / moved /
// renamed / unchanged) via the Entity Registry — canonical identity is
// the right granularity for point features that either exist or don't.
//
// Line (segment-level) diff lives in `src/gtfs/segment-graph.ts`: shapes
// are conflated onto a shared global grid and diffed as a set of
// undirected cell-edges. That module owns the `GeomStatus` enum and the
// `SEGMENT_COLOR` palette; this file is intentionally stop-only now.

import type { DiffResult, StopStatus, StopDiffEntry } from './engine';

export const DIFF_COLOR: Record<StopStatus, string> = {
  added: '#16a34a',    // green-600 — matches SEGMENT_COLOR.added for visual unity
  removed: '#dc2626',  // red-600  — matches SEGMENT_COLOR.removed for visual unity
  moved: '#fbbf24',    // var(--modified)
  renamed: '#60a5fa',  // a softer accent
  unchanged: '#6b7280',
};

function mainPosition(e: StopDiffEntry): [number, number] | null {
  switch (e.status) {
    case 'added':
      return e.b ? [e.b.lon, e.b.lat] : null;
    case 'removed':
      return e.a ? [e.a.lon, e.a.lat] : null;
    case 'moved':
      return e.b ? [e.b.lon, e.b.lat] : e.a ? [e.a.lon, e.a.lat] : null;
    case 'renamed':
    case 'unchanged':
      // A and B are (approximately) the same; prefer B as "current".
      if (e.b) return [e.b.lon, e.b.lat];
      if (e.a) return [e.a.lon, e.a.lat];
      return [e.canonical.lon, e.canonical.lat];
  }
}

export function diffStopPoints(
  result: DiffResult,
  visibility: Record<StopStatus, boolean>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const e of result.stops) {
    if (!visibility[e.status]) continue;
    const coord = mainPosition(e);
    if (!coord) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coord },
      properties: {
        canonicalId: e.canonicalId,
        status: e.status,
        a_name: e.a?.name ?? null,
        b_name: e.b?.name ?? null,
        dist_m: Math.round(e.distM),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Ghost dots at the "before" (A) position for moved stops. */
export function diffStopGhosts(
  result: DiffResult,
  visibility: Record<StopStatus, boolean>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const e of result.stops) {
    if (e.status !== 'moved') continue;
    if (!visibility.moved) continue;
    if (!e.a) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.a.lon, e.a.lat] },
      properties: {
        canonicalId: e.canonicalId,
        status: 'moved-from',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Arrows (LineStrings) from A→B for moved stops. */
export function diffMoveArrows(
  result: DiffResult,
  visibility: Record<StopStatus, boolean>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const e of result.stops) {
    if (e.status !== 'moved') continue;
    if (!visibility.moved) continue;
    if (!e.a || !e.b) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [e.a.lon, e.a.lat],
          [e.b.lon, e.b.lat],
        ],
      },
      properties: {
        canonicalId: e.canonicalId,
        dist_m: Math.round(e.distM),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
