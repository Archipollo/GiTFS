// Reroute detection for the Timeline change panel + map overlay.
//
// The entity-diff `RouteStatus` (added/removed/renumbered/modified/unchanged)
// never reflects a route keeping its identity but taking a different physical
// path — that's a `geom_status: 'changed'` run from the route-scoped
// buffer-overlay diff (`segment-graph.ts`), the same pipeline the A/B diff
// line list uses to badge a line "Rerouted". This module runs that pipeline
// for the timeline's baseline/current pair so the panel and map can surface
// the same thing.

import { buildRoutePairs, getDiffedShapes, getShapeIndex, segmentDiffToGeoJSON } from '../gtfs/segment-graph';
import type { DiffResult } from '../diff/engine';

export interface TimelineRerouteResult {
  reroutedRouteCount: number;
  geojson: GeoJSON.FeatureCollection;
}

/** Distinct canonical routes with at least one `changed` (rerouted) run, plus the new-alignment geometry for map highlighting. */
export async function computeTimelineReroutes(diff: DiffResult): Promise<TimelineRerouteResult> {
  const pairs = buildRoutePairs(diff);
  const [idxA, idxB] = await Promise.all([getShapeIndex(diff.feedA), getShapeIndex(diff.feedB)]);
  const diffed = await getDiffedShapes(idxA, idxB, pairs, diff.builtAt);

  const reroutedIds = new Set<string>();
  for (const run of diffed.runs) {
    if (run.status === 'changed') reroutedIds.add(run.canonicalId);
  }

  // Only the new (feed B) alignment — the old one is drawn as a paired
  // `changed` run purely so `segmentDiffToGeoJSON` can compute lengths; a map
  // highlight only wants "here's the path today that differs from baseline".
  const { features } = segmentDiffToGeoJSON(
    diffed,
    { added: false, removed: false, unchanged: false, changed: true },
    (r) => r.status !== 'changed' || r.changedSide === 'new',
  );

  return { reroutedRouteCount: reroutedIds.size, geojson: features };
}
