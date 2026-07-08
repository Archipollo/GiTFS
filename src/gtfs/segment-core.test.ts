import { describe, expect, it } from 'vitest';
import {
  buildShapeIndex,
  diffShapes,
  diffShapesByRoute,
  lineLengthM,
  type DiffedRun,
  type RoutePair,
} from './segment-core';
import type { ShapePolyline } from './queries';
import { buildRoutePairs } from './segment-graph';
import type { DiffResult, RouteDiffEntry, RouteSide } from '../diff/engine';
import type { CanonicalRoute } from '../registry/routes-matcher';

// Mirrors segment-core.ts's local equirectangular projection (LAT_REF = 47.5)
// so metre-scale offsets in these fixtures land where the module itself
// expects them, without needing to export the projection helpers.
const LAT_REF = 47.5;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT_REF * Math.PI) / 180);
const ORIGIN_LON = 14;
const ORIGIN_LAT = 47.5;

function m(xM: number, yM: number): [number, number] {
  return [ORIGIN_LON + xM / M_PER_DEG_LON, ORIGIN_LAT + yM / M_PER_DEG_LAT];
}

// `coords` are already lon/lat pairs produced by `m(...)` at the call site —
// this helper does not re-project them.
function shape(id: string, coords: [number, number][], routeId = ''): ShapePolyline {
  return {
    shape_id: id,
    coords,
    modes: [],
    primary_mode: 'other',
    route_id: routeId,
  };
}

function statuses(runs: readonly DiffedRun[]): string[] {
  return [...new Set(runs.map((r) => r.status))];
}

describe('tight-turn tangent false positive (Fix 2)', () => {
  it('does not misclassify a corner where feed B cuts across with different vertex density', () => {
    // Feed A: sharp right-angle corner, coarse (3 vertices only).
    const a = shape('corner', [m(0, 0), m(0, 30), m(30, 30)]);
    // Feed B: same physical corridor, but the corner is represented with a
    // short diagonal cut (extra vertex) instead of a sharp turn — this is
    // exactly the kind of feed-to-feed vertex density mismatch that made
    // the raw single-segment tangent gate misfire pre-fix.
    const b = shape('corner', [m(0, 0), m(0, 29), m(3, 30), m(30, 30)]);

    const idxA = buildShapeIndex('A', [a]);
    const idxB = buildShapeIndex('B', [b]);
    const diffed = diffShapes(idxA, idxB);

    expect(statuses(diffed.runs)).toEqual(['unchanged']);
  });

  it('control: identical corner geometry on both sides is unchanged (sanity baseline)', () => {
    const coords: [number, number][] = [m(0, 0), m(0, 30), m(30, 30)];
    const a = shape('corner', coords);
    const b = shape('corner', coords);

    const idxA = buildShapeIndex('A', [a]);
    const idxB = buildShapeIndex('B', [b]);
    const diffed = diffShapes(idxA, idxB);

    expect(statuses(diffed.runs)).toEqual(['unchanged']);
  });

  it('regression guard: a genuinely new perpendicular cross-street is still mostly classified as added', () => {
    // Feed A: a single north-south street, unchanged in B.
    const streetCoords: [number, number][] = [m(100, 0), m(100, 100)];
    const a = shape('street', streetCoords);
    const bStreet = shape('street', streetCoords);
    // Feed B also has a brand-new east-west cross-street crossing it at
    // (100, 50) — physically new, not present in feed A at all.
    const bCross = shape('cross', [m(80, 50), m(120, 50)]);

    const idxA = buildShapeIndex('A', [a]);
    const idxB = buildShapeIndex('B', [bStreet, bCross]);
    const diffed = diffShapes(idxA, idxB);

    const streetRuns = diffed.runs.filter((r) => r.shape_id === 'street');
    expect(statuses(streetRuns)).toEqual(['unchanged']);

    const crossRuns = diffed.runs.filter((r) => r.shape_id === 'cross' && r.feed === 'b');
    const addedLen = crossRuns
      .filter((r) => r.status === 'added')
      .reduce((sum, r) => sum + lineLengthM(r.coords), 0);
    const totalLen = crossRuns.reduce((sum, r) => sum + lineLengthM(r.coords), 0);
    expect(totalLen).toBeGreaterThan(35); // ~40m cross-street
    // Only a small stub near the junction (bounded by FALLBACK_M) may be
    // spuriously unchanged — the rest must still read as added.
    expect(addedLen / totalLen).toBeGreaterThan(0.6);
  });
});

describe('route-scoped ("tube map") geometry diff (Fix 1)', () => {
  it('marks a removed route as removed even when another route shares its street', () => {
    const sharedStreet: [number, number][] = [m(200, 0), m(200, 100)];

    const shapesA: ShapePolyline[] = [
      shape('shape_58', sharedStreet, 'r58'),
      shape('shape_12a', sharedStreet, 'r12'),
    ];
    const shapesB: ShapePolyline[] = [
      shape('shape_12b', sharedStreet, 'r12'),
    ];

    const shapeRouteMapA = new Map<string, string[]>([
      ['shape_58', ['r58']],
      ['shape_12a', ['r12']],
    ]);
    const shapeRouteMapB = new Map<string, string[]>([
      ['shape_12b', ['r12']],
    ]);

    const pairs: RoutePair[] = [
      { canonicalId: 'c58', aRawIds: ['r58'], bRawIds: [] }, // removed, no B counterpart
      { canonicalId: 'c12', aRawIds: ['r12'], bRawIds: ['r12'] }, // matched, unchanged
    ];

    const diffed = diffShapesByRoute(
      'A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs,
    );

    const route58Runs = diffed.runs.filter((r) => r.shape_id === 'shape_58');
    expect(route58Runs.length).toBeGreaterThan(0);
    expect(statuses(route58Runs)).toEqual(['removed']);
    expect(route58Runs.every((r) => r.canonicalId === 'c58')).toBe(true);

    const route12Runs = diffed.runs.filter(
      (r) => r.shape_id === 'shape_12a' || r.shape_id === 'shape_12b',
    );
    expect(route12Runs.length).toBeGreaterThan(0);
    expect(statuses(route12Runs)).toEqual(['unchanged']);
  });
});

describe('buildRoutePairs', () => {
  function routeSide(rawIds: string[]): RouteSide {
    return { shortName: '', longName: '', agencyName: '', mode: 'bus', rawIds };
  }

  function canonical(id: string): CanonicalRoute {
    return {
      canonicalId: id, shortName: '', longName: '', agency: '', mode: 'bus',
      memberCount: 1, feedCount: 1,
    };
  }

  function entry(overrides: Partial<RouteDiffEntry>): RouteDiffEntry {
    return {
      canonicalId: 'c', canonical: canonical('c'), status: 'unchanged',
      a: null, b: null, ...overrides,
    };
  }

  function result(routes: RouteDiffEntry[]): DiffResult {
    return {
      feedA: 'A', feedB: 'B', builtAt: 0, stops: [], routes,
      summary: {
        stops: { added: 0, removed: 0, moved: 0, renamed: 0, unchanged: 0 },
        routes: { added: 0, removed: 0, renumbered: 0, modified: 0, unchanged: 0 },
      },
    };
  }

  it('maps added/removed to one-sided pairs and unchanged/modified/renumbered to two-sided pairs', () => {
    const routes: RouteDiffEntry[] = [
      entry({ canonicalId: 'removed1', status: 'removed', a: routeSide(['ra']), b: null }),
      entry({ canonicalId: 'added1', status: 'added', a: null, b: routeSide(['rb']) }),
      entry({ canonicalId: 'unchanged1', status: 'unchanged', a: routeSide(['rc']), b: routeSide(['rc']) }),
      entry({ canonicalId: 'renumbered1', status: 'renumbered', a: routeSide(['rd']), b: routeSide(['re']) }),
    ];

    const pairs = buildRoutePairs(result(routes));

    expect(pairs).toEqual([
      { canonicalId: 'removed1', aRawIds: ['ra'], bRawIds: [] },
      { canonicalId: 'added1', aRawIds: [], bRawIds: ['rb'] },
      { canonicalId: 'unchanged1', aRawIds: ['rc'], bRawIds: ['rc'] },
      { canonicalId: 'renumbered1', aRawIds: ['rd'], bRawIds: ['re'] },
    ]);
  });
});
