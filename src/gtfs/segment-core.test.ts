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

describe('reroute pairing ("changed" status)', () => {
  function changedSides(runs: readonly DiffedRun[]): (string | undefined)[] {
    return runs.filter((r) => r.status === 'changed').map((r) => r.changedSide);
  }

  it('pairs a removed run and an added run on the same route into changed old/new when nearby but beyond TOL_M', () => {
    // 80m apart: outside the 25m buffer-overlay tolerance (so the primary
    // pass reports removed/added), but well inside CHANGED_TOL_M (150m).
    const oldStreet: [number, number][] = [m(200, 0), m(200, 200)];
    const newStreet: [number, number][] = [m(280, 0), m(280, 200)];

    const shapesA: ShapePolyline[] = [shape('old', oldStreet, 'r1')];
    const shapesB: ShapePolyline[] = [shape('new', newStreet, 'r1')];
    const shapeRouteMapA = new Map([['old', ['r1']]]);
    const shapeRouteMapB = new Map([['new', ['r1']]]);
    const pairs: RoutePair[] = [{ canonicalId: 'c1', aRawIds: ['r1'], bRawIds: ['r1'] }];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    expect(statuses(diffed.runs)).toEqual(['changed']);
    const aRuns = diffed.runs.filter((r) => r.feed === 'a');
    const bRuns = diffed.runs.filter((r) => r.feed === 'b');
    expect(changedSides(aRuns)).toEqual(['old']);
    expect(changedSides(bRuns)).toEqual(['new']);
  });

  it('diagnostic: a diverge-and-rejoin reroute highlights only the >TOL_M middle, not the full divergence span', () => {
    // Reproduces the real-world Doppl case: one route, realigned off a
    // through-the-buildings straight onto the adjacent road, rejoining at both
    // ends. Documents *why* the yellow highlight reads shorter on the map than
    // the divergence looks to the eye — the taper where the two alignments are
    // still within TOL_M (25m) of each other classifies as `unchanged`, so only
    // the genuinely-separated middle survives as `changed`.
    const oldStraight: [number, number][] = [m(0, 0), m(0, 1000)];
    const newAligned: [number, number][] = [
      m(0, 0), m(0, 200), m(60, 350), m(60, 650), m(0, 800), m(0, 1000),
    ];

    const shapesA: ShapePolyline[] = [shape('old', oldStraight, 'r1')];
    const shapesB: ShapePolyline[] = [shape('new', newAligned, 'r1')];
    const pairs: RoutePair[] = [{ canonicalId: 'c1', aRawIds: ['r1'], bRawIds: ['r1'] }];

    const diffed = diffShapesByRoute(
      'A', 'B', shapesA, shapesB,
      new Map([['old', ['r1']]]), new Map([['new', ['r1']]]),
      pairs,
    );

    // No orphaned red/green fragments: every non-unchanged run got paired.
    expect(statuses(diffed.runs).sort()).toEqual(['changed', 'unchanged']);

    const changedA = diffed.runs.filter((r) => r.feed === 'a' && r.status === 'changed');
    expect(changedSides(changedA)).toEqual(['old']);
    const changedLen = changedA.reduce((sum, r) => sum + lineLengthM(r.coords), 0);

    // The alignments visibly part at y=200 and rejoin at y=800 (600m), but the
    // classified `changed` stretch is materially shorter — it starts only once
    // the separation exceeds TOL_M and ends as soon as it drops back under.
    expect(changedLen).toBeLessThan(550);
    expect(changedLen).toBeGreaterThan(250);

    // The flanks stay unchanged and connected, so the highlight sits inside a
    // continuous corridor rather than floating free.
    const unchangedA = diffed.runs.filter((r) => r.feed === 'a' && r.status === 'unchanged');
    expect(unchangedA.length).toBe(2);
  });

  it('regression: a route removed with no B counterpart at all stays pure removed, never changed', () => {
    const street: [number, number][] = [m(200, 0), m(200, 200)];
    const shapesA: ShapePolyline[] = [shape('gone', street, 'r2')];
    const shapesB: ShapePolyline[] = [];
    const shapeRouteMapA = new Map([['gone', ['r2']]]);
    const shapeRouteMapB = new Map<string, string[]>();
    const pairs: RoutePair[] = [{ canonicalId: 'c2', aRawIds: ['r2'], bRawIds: [] }];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    expect(statuses(diffed.runs)).toEqual(['removed']);
  });

  it('a genuinely new spur far from the removed corridor stays added, not changed', () => {
    const oldStreet: [number, number][] = [m(400, 0), m(400, 200)];
    const rerouted: [number, number][] = [m(470, 0), m(470, 200)]; // 70m away — pairs
    const spur: [number, number][] = [m(1000, 0), m(1000, 50)]; // far away — independent

    const shapesA: ShapePolyline[] = [shape('old', oldStreet, 'r3')];
    const shapesB: ShapePolyline[] = [shape('rerouted', rerouted, 'r3'), shape('spur', spur, 'r3')];
    const shapeRouteMapA = new Map([['old', ['r3']]]);
    const shapeRouteMapB = new Map([['rerouted', ['r3']], ['spur', ['r3']]]);
    const pairs: RoutePair[] = [{ canonicalId: 'c3', aRawIds: ['r3'], bRawIds: ['r3'] }];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    const reroutedRuns = diffed.runs.filter((r) => r.shape_id === 'rerouted');
    expect(statuses(reroutedRuns)).toEqual(['changed']);

    const spurRuns = diffed.runs.filter((r) => r.shape_id === 'spur');
    expect(statuses(spurRuns)).toEqual(['added']);
  });

  it('never pairs a removed run against an added run belonging to a different canonical route', () => {
    // c4's removed run and c5's added run are only 70m apart in real space
    // (well within CHANGED_TOL_M) — if pairing were global instead of
    // per-canonicalId, they would incorrectly reclassify as changed.
    const c4Removed: [number, number][] = [m(500, 0), m(500, 100)];
    const c4Added: [number, number][] = [m(500, 500), m(500, 600)]; // far from c4Removed
    const c5Removed: [number, number][] = [m(500, 1000), m(500, 1100)]; // far from c5Added
    const c5Added: [number, number][] = [m(570, 0), m(570, 100)]; // 70m from c4Removed

    const shapesA: ShapePolyline[] = [
      shape('c4a', c4Removed, 'r4a'),
      shape('c5a', c5Removed, 'r5a'),
    ];
    const shapesB: ShapePolyline[] = [
      shape('c4b', c4Added, 'r4b'),
      shape('c5b', c5Added, 'r5b'),
    ];
    const shapeRouteMapA = new Map([['c4a', ['r4a']], ['c5a', ['r5a']]]);
    const shapeRouteMapB = new Map([['c4b', ['r4b']], ['c5b', ['r5b']]]);
    const pairs: RoutePair[] = [
      { canonicalId: 'c4', aRawIds: ['r4a'], bRawIds: ['r4b'] },
      { canonicalId: 'c5', aRawIds: ['r5a'], bRawIds: ['r5b'] },
    ];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    const c4aRuns = diffed.runs.filter((r) => r.shape_id === 'c4a');
    const c5bRuns = diffed.runs.filter((r) => r.shape_id === 'c5b');
    expect(statuses(c4aRuns)).toEqual(['removed']);
    expect(statuses(c5bRuns)).toEqual(['added']);
  });

  it('regression: asymmetric coverage — a long removed run mostly orphaned stays removed even when a short nearby added run individually clears coverage', () => {
    // Long removed run (1000m): only ~240m of it falls within CHANGED_TOL_M
    // of the short added run below, so its own union-coverage test fails
    // (well under 60%). The short added run sits entirely 60m from the
    // removed run's start, so *its* own union-coverage test passes at
    // 100%. Before mutual pairing, the added run alone got promoted to
    // 'changed', leaving an orphaned yellow stub next to an unrelated-
    // looking red run. With mutual pairing, neither side has a partner
    // that passes its own test, so both keep their original status.
    const longRemoved: [number, number][] = [m(200, 0), m(200, 1000)];
    const shortAdded: [number, number][] = [m(260, 0), m(260, 100)];

    const shapesA: ShapePolyline[] = [shape('longRemoved', longRemoved, 'r6')];
    const shapesB: ShapePolyline[] = [shape('shortAdded', shortAdded, 'r6')];
    const shapeRouteMapA = new Map([['longRemoved', ['r6']]]);
    const shapeRouteMapB = new Map([['shortAdded', ['r6']]]);
    const pairs: RoutePair[] = [{ canonicalId: 'c6', aRawIds: ['r6'], bRawIds: ['r6'] }];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    const removedRuns = diffed.runs.filter((r) => r.shape_id === 'longRemoved');
    const addedRuns = diffed.runs.filter((r) => r.shape_id === 'shortAdded');
    expect(statuses(removedRuns)).toEqual(['removed']);
    expect(statuses(addedRuns)).toEqual(['added']);
  });

  it('pairs a removed run and an added run of uneven length into changed old/new when both individually clear coverage', () => {
    const oldStreet: [number, number][] = [m(300, 0), m(300, 200)]; // 200m long
    const newStreet: [number, number][] = [m(360, 0), m(360, 150)]; // 150m long, 60m away

    const shapesA: ShapePolyline[] = [shape('old7', oldStreet, 'r7')];
    const shapesB: ShapePolyline[] = [shape('new7', newStreet, 'r7')];
    const shapeRouteMapA = new Map([['old7', ['r7']]]);
    const shapeRouteMapB = new Map([['new7', ['r7']]]);
    const pairs: RoutePair[] = [{ canonicalId: 'c7', aRawIds: ['r7'], bRawIds: ['r7'] }];

    const diffed = diffShapesByRoute('A', 'B', shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs);

    expect(statuses(diffed.runs)).toEqual(['changed']);
    const aRuns = diffed.runs.filter((r) => r.feed === 'a');
    const bRuns = diffed.runs.filter((r) => r.feed === 'b');
    expect(changedSides(aRuns)).toEqual(['old']);
    expect(changedSides(bRuns)).toEqual(['new']);
  });
});

describe('run-length smoothing', () => {
  it('collapses a short spurious removed blip surrounded by unchanged into pure unchanged', () => {
    // Feed A: a straight street with a short detour in the middle (10m out
    // and back) that feed B does not follow — classified unchanged/removed/
    // unchanged/removed/unchanged. Each removed stretch (~10m) is well
    // under MIN_RUN_M (40m) and should be smoothed away as confetti.
    const a = shape('street', [
      m(0, 0), m(0, 100), m(10, 100), m(10, 110), m(0, 110), m(0, 200),
    ]);
    const b = shape('street', [m(0, 0), m(0, 200)]);

    const idxA = buildShapeIndex('A', [a]);
    const idxB = buildShapeIndex('B', [b]);
    const diffed = diffShapes(idxA, idxB);

    const aRuns = diffed.runs.filter((r) => r.feed === 'a');
    expect(statuses(aRuns)).toEqual(['unchanged']);
  });

  it('merges a short run at a shape boundary into its only neighbour without erroring', () => {
    // Feed A starts with a brief 5m stub that diverges from feed B before
    // settling onto the shared corridor for the rest of its length — the
    // stub run has no left neighbour, only a right one.
    const a = shape('street', [m(0, 0), m(5, 5), m(0, 10), m(0, 300)]);
    const b = shape('street', [m(0, 10), m(0, 300)]);

    const idxA = buildShapeIndex('A', [a]);
    const idxB = buildShapeIndex('B', [b]);

    expect(() => diffShapes(idxA, idxB)).not.toThrow();
    const diffed = diffShapes(idxA, idxB);
    const aRuns = diffed.runs.filter((r) => r.feed === 'a');
    expect(aRuns.length).toBeGreaterThan(0);
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

describe('per-direction scoping', () => {
  // The two directions of a line share the same street, 10m apart — well
  // inside TOL_M (25m), as a real bidirectional corridor is. This is what
  // makes union-pooling wrong: the inbound geometry covers the outbound's
  // corridor, so an outbound-only change is invisible when both directions
  // are buffered into one index.
  const OUT: [number, number][] = [m(0, 0), m(1000, 0)];
  const IN: [number, number][] = [m(1000, 10), m(0, 10)];

  const routeMap = (ids: string[]): Map<string, string[]> =>
    new Map(ids.map((id) => [id, ['r191']]));
  const dirMap = new Map([['out', 0], ['in', 1]]);

  const pairs: RoutePair[] = [{ canonicalId: 'c191', aRawIds: ['r191'], bRawIds: ['r191'] }];

  // Feed B reroutes the *outbound* onto a parallel street 300m away and
  // leaves the inbound untouched.
  const shapesA = [shape('out', OUT, 'r191'), shape('in', IN, 'r191')];
  const shapesB = [
    shape('out', [m(0, 300), m(1000, 300)], 'r191'),
    shape('in', IN, 'r191'),
  ];

  it('detects a reroute in one direction that the other direction covers', () => {
    const diffed = diffShapesByRoute(
      'A', 'B', shapesA, shapesB,
      routeMap(['out', 'in']), routeMap(['out', 'in']),
      pairs, undefined, dirMap, dirMap,
    );

    // Pooled, A's old outbound sits 10m from B's inbound and so reads
    // `unchanged` — the reroute vanishes. Scoped per direction it is
    // compared only against B's outbound, 300m away.
    const oldOut = diffed.runs.filter((r) => r.shape_id === 'out' && r.feed === 'a');
    expect(oldOut.length).toBeGreaterThan(0);
    expect(statuses(oldOut)).not.toContain('unchanged');

    // The untouched inbound still reads unchanged.
    const inRuns = diffed.runs.filter((r) => r.shape_id === 'in');
    expect(statuses(inRuns)).toEqual(['unchanged']);
  });

  it('leaves no orphaned new-side geometry for a one-direction reroute', () => {
    const diffed = diffShapesByRoute(
      'A', 'B', shapesA, shapesB,
      routeMap(['out', 'in']), routeMap(['out', 'in']),
      pairs, undefined, dirMap, dirMap,
    );

    // The inconsistency this fixes: pooled, B's new outbound is `added`
    // (nothing covers it) while A's old outbound is masked `unchanged`,
    // drawing a lone green line with no red/old counterpart. Both sides of
    // the outbound change must now be reported together.
    const outRuns = diffed.runs.filter((r) => r.shape_id === 'out');
    const aSide = outRuns.filter((r) => r.feed === 'a');
    const bSide = outRuns.filter((r) => r.feed === 'b');
    expect(aSide.length).toBeGreaterThan(0);
    expect(bSide.length).toBeGreaterThan(0);
    expect(statuses(aSide)).not.toContain('unchanged');
    expect(statuses(bSide)).not.toContain('unchanged');
  });

  it('falls back to the whole-route union when the feeds disagree on direction structure', () => {
    // Feed A models the line as one bidirectional shape (no direction id);
    // feed B splits it into two. Forcing a per-direction diff here would
    // emit B's buckets wholesale as `added` and A's as `removed`, since
    // neither direction key exists on the other side. The fallback keeps
    // the union comparison, so the shared corridor still reads unchanged.
    const bothA = [shape('both', OUT, 'r191')];
    const splitB = [shape('out', OUT, 'r191'), shape('in', IN, 'r191')];
    const diffed = diffShapesByRoute(
      'A', 'B', bothA, splitB,
      routeMap(['both']), routeMap(['out', 'in']),
      pairs, undefined, new Map([['both', -1]]), dirMap,
    );

    expect(statuses(diffed.runs)).toEqual(['unchanged']);
  });

  it('is a no-op when no direction map is supplied (existing callers)', () => {
    const diffed = diffShapesByRoute(
      'A', 'B', shapesA, shapesA,
      routeMap(['out', 'in']), routeMap(['out', 'in']), pairs,
    );
    expect(statuses(diffed.runs)).toEqual(['unchanged']);
  });
});
