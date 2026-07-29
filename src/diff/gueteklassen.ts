// Diff-mode ÖV-Güteklassen overlay. Unlike population's numeric density,
// A-G is an ordinal/categorical grade — there's no meaningful "delta" to
// subtract. So this module produces two things instead of one:
//
//   - Per-feed absolute grids (feedA/feedB), rendered side by side in split
//     view exactly like population's per-pane absolute mode.
//   - A single categorical "change" layer for the network-diff overview,
//     comparing each cell's ordinal position (A=0..G=6, plus a null/no-
//     coverage state) between the two feeds: improved, degraded, unchanged,
//     gained coverage, or lost coverage.

import {
  computeFeedGueteklassen,
  type Bbox,
  type FeedGueteklassenResult,
  type GueteklassenSummary,
  type Guteklasse,
} from '../gtfs/gueteklassen';

export interface GueteklassenDiffResult {
  feedA: string;
  feedB: string;
  resultA: FeedGueteklassenResult;
  resultB: FeedGueteklassenResult;
}

export async function computeGueteklassenDiff(
  feedA: string,
  feedB: string,
  bbox: Bbox,
): Promise<GueteklassenDiffResult> {
  const [resultA, resultB] = await Promise.all([
    computeFeedGueteklassen(feedA, bbox),
    computeFeedGueteklassen(feedB, bbox),
  ]);
  return { feedA, feedB, resultA, resultB };
}

function bboxKey(bbox: Bbox): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

const cache = new Map<string, Promise<GueteklassenDiffResult>>();

export function getOrComputeGueteklassenDiff(feedA: string, feedB: string, bbox: Bbox): Promise<GueteklassenDiffResult> {
  const key = `${feedA}:${feedB}:${bboxKey(bbox)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = computeGueteklassenDiff(feedA, feedB, bbox).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}

/** Per-side absolute choropleth, for split view's independent panes. */
export function gueteklassenDiffToGeoJSON(result: GueteklassenDiffResult, side: 'a' | 'b'): GeoJSON.FeatureCollection {
  const { grid } = side === 'a' ? result.resultA : result.resultB;
  const features: GeoJSON.Feature[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const idx = row * grid.cols + col;
      const cls = grid.classes[idx];
      if (cls < 0) continue;
      const w = grid.west + col * grid.cellSizeX;
      const e = w + grid.cellSizeX;
      const n = grid.north - row * grid.cellSizeY;
      const s = n - grid.cellSizeY;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: { class: cls, distance_m: Math.round(grid.nearestDistanceM[idx]) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export type GueteklassenChange = 'improved' | 'degraded' | 'unchanged' | 'gained' | 'lost';

export interface GueteklassenChangeSummary {
  feedA: string;
  feedB: string;
  changeCounts: Record<GueteklassenChange, number>;
  cellCount: number;
}

function classifyChange(a: number, b: number): GueteklassenChange | null {
  if (a < 0 && b < 0) return null; // never covered on either side — not worth a cell
  if (a < 0 && b >= 0) return 'gained';
  if (a >= 0 && b < 0) return 'lost';
  if (b < a) return 'improved'; // lower ordinal = better letter (A=0)
  if (b > a) return 'degraded';
  return 'unchanged';
}

/**
 * Per-cell categorical change layer for the network-diff overview — the
 * grids for feed A and B share the same bbox/lattice snapping, so cells line
 * up index-for-index without any re-gridding step (same guarantee
 * `populationDiffToGeoJSON` relies on).
 */
export function gueteklassenChangeToGeoJSON(result: GueteklassenDiffResult): GeoJSON.FeatureCollection {
  const gridA = result.resultA.grid;
  const gridB = result.resultB.grid;
  const cols = Math.min(gridA.cols, gridB.cols);
  const rows = Math.min(gridA.rows, gridB.rows);
  const features: GeoJSON.Feature[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = gridA.classes[row * gridA.cols + col];
      const b = gridB.classes[row * gridB.cols + col];
      const change = classifyChange(a, b);
      if (!change) continue;
      const w = gridA.west + col * gridA.cellSizeX;
      const e = w + gridA.cellSizeX;
      const n = gridA.north - row * gridA.cellSizeY;
      const s = n - gridA.cellSizeY;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: { change, class_a: a, class_b: b },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export function summarizeGueteklassenChange(result: GueteklassenDiffResult): GueteklassenChangeSummary {
  const gridA = result.resultA.grid;
  const gridB = result.resultB.grid;
  const cols = Math.min(gridA.cols, gridB.cols);
  const rows = Math.min(gridA.rows, gridB.rows);
  const changeCounts: Record<GueteklassenChange, number> = {
    improved: 0, degraded: 0, unchanged: 0, gained: 0, lost: 0,
  };
  let cellCount = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = gridA.classes[row * gridA.cols + col];
      const b = gridB.classes[row * gridB.cols + col];
      const change = classifyChange(a, b);
      if (!change) continue;
      changeCounts[change]++;
      cellCount++;
    }
  }
  return { feedA: result.feedA, feedB: result.feedB, changeCounts, cellCount };
}

/** Re-exported so callers only need to import from this module for the
 * absolute per-side summaries too (mirrors population's split-mode use of
 * `PopulationSummary` from gtfs/population.ts directly). */
export type { GueteklassenSummary, Guteklasse };

// ---- colours (5-category change layer) -----------------------------------

export const GUETEKLASSEN_CHANGE_COLOR: Readonly<Record<GueteklassenChange, string>> = {
  improved: '#16a34a',
  degraded: '#dc2626',
  unchanged: '#e5e7eb',
  gained: '#2563eb',
  lost: '#6b7280',
};
