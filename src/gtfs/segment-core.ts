// Buffer-overlay diff for GTFS shapes — no buffer polygons actually
// constructed.
//
// Conceptually this is the textbook GIS set operation
//
//     bufferB = buffer(B_shapes, TOL_M)
//     bufferA = buffer(A_shapes, TOL_M)
//
//     unchanged = A ∩ bufferB        (drawn from A only)
//     removed   = A − bufferB
//     added     = B − bufferA
//
// but we never materialise the buffer polygons. "Is this point inside
// buffer(B)?" reduces to "is this point within TOL_M of any B
// segment", which a uniform-grid segment index answers in
// microseconds. That keeps the diff fast (~ms-to-low-seconds even on
// country-scale feeds) compared to going through JSTS-backed
// turf.buffer + turf.lineSplit, which builds thousands of circular
// buffer polygons and intersects line-by-line against them.
//
// For each polyline we walk along its arc length in fixed `STEP_M`
// steps (not at GTFS vertices — that was the bias the previous
// implementation suffered from) and classify each sample. When the
// classification flips between two adjacent samples, a 12-iteration
// binary search localises the exact crossing on the underlying
// segment to sub-metre precision. Each emitted run is a sub-portion
// of the original GTFS polyline plus at most one interpolated vertex
// per crossing — nothing is invented or resampled.
//
// One refinement on top of the textbook formulation: the buffer match
// is *direction-aware*. A point on A only counts as "inside buffer(B)"
// if some B-segment within TOL_M has a tangent within COS_DIR_MIN of
// A's local segment direction (parallel or anti-parallel — buses can
// run either way along the same street). Without this, a perpendicular
// cross-street in B falsely "covers" the first ~TOL_M of an A-segment
// changing direction at a junction, leaving a slate stub at every
// changed-street endpoint.
//
// This module is pure computation (no DOM, no DuckDB) so it can be
// imported inside the diff Web Worker safely.

import type { Mode } from './modes';
import type { ShapePolyline } from './queries';

// ---- Algorithm parameters -------------------------------------------

/**
 * Point-to-line tolerance in metres. Two shape stretches are
 * considered the same physical street when their perpendicular
 * separation is at most this distance.
 *
 * 25 m is tight enough that genuinely parallel urban streets stay
 * distinct, while still absorbing the typical digitisation jitter
 * between Austrian GTFS feeds (snap accuracy is usually 5–15 m).
 */
export const TOL_M = 25;

/**
 * Arc-length step used to walk each polyline. Must be ≤ TOL_M so
 * we can never skip across a transition zone narrower than the
 * tolerance itself. TOL_M / 2 is a good default — fine enough not
 * to miss brief crossings, coarse enough to keep the walk cheap.
 */
const STEP_M = TOL_M / 2;

/** Grid cell size = 2 × TOL_M so a 3×3 cell neighbourhood always suffices. */
const GRID_M = TOL_M * 2;

/**
 * Binary-search iterations to localise a crossing. 12 iterations
 * gives 1/2^12 ≈ 0.024 % of STEP_M, i.e. sub-millimetre precision
 * for STEP_M = 12.5 m — far better than any visualisation needs.
 */
const BSEARCH_ITERS = 12;

/**
 * Minimum |cos(angle)| between A's local segment direction and a
 * candidate B-segment's tangent for that B-segment to count as a
 * buffer match. cos(45°) ≈ 0.707 admits the typical chord wiggle
 * along curves and slight digitisation differences while rejecting
 * perpendicular (and most acute-angle) cross-streets that meet A at
 * junctions but don't share its physical street.
 *
 * Anti-parallel matches count too — bus shapes for opposing
 * directions traverse the same street with reversed tangent, so we
 * compare on |dot product| not the raw dot product.
 */
const COS_DIR_MIN = Math.cos(Math.PI / 4);

/**
 * Below this distance, treat a candidate as the same physical corridor
 * regardless of tangent noise. This is the primary defense against
 * direction-gate false positives on tight turns/loops: feed A and feed B
 * rarely digitize a curve with identical vertex spacing, so the raw
 * per-vertex tangent at matching arc-length positions can differ by more
 * than COS_DIR_MIN even when every point is a few metres apart. Bounds the
 * reintroduced cross-street risk to a ~2*FALLBACK_M stub at a genuine
 * junction, instead of the ~2*TOL_M stub a fully-removed direction gate
 * would allow. Loosening COS_DIR_MIN instead is not a safe alternative:
 * worst-case density mismatch can push tangents ~90° apart, and a looser
 * threshold also readmits genuine perpendicular cross-streets.
 */
const FALLBACK_M = 5;
const FALLBACK_SQ = FALLBACK_M * FALLBACK_M;

/**
 * Arc-length window (metres, each side) used to smooth the tangent at a
 * vertex, instead of deriving it from a single raw two-vertex GTFS
 * segment. Complementary to FALLBACK_M: it reduces tangent noise in the
 * 5-25m band where the distance fallback doesn't apply, but a window wide
 * enough to smooth a tight loop can blend a sharp real junction's two legs
 * into a diagonal — so this is a secondary refinement, not a replacement
 * for the distance fallback, which is what actually bounds correctness.
 */
const TANGENT_WINDOW_M = STEP_M;

// ---- Local equirectangular projection (metres around Austria) -------

// Local projection anchor tuned for Central Europe (Austria-centric feeds).
// If this diffing engine is reused for a far-away region, update LAT_REF.
const LAT_REF = 47.5;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT_REF * Math.PI) / 180);

function lonToX(lon: number): number { return lon * M_PER_DEG_LON; }
function latToY(lat: number): number { return lat * M_PER_DEG_LAT; }

const EARTH_R = 6_371_000;
function haversineM(
  aLon: number, aLat: number,
  bLon: number, bLat: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function projPoint(c: readonly [number, number]): [number, number] {
  return [lonToX(c[0]), latToY(c[1])];
}

/**
 * Walk along `coords` (projected to metres) from vertex `i`, forward if
 * `arcM > 0` else backward, until `|arcM|` metres of arc length are
 * covered or the shape end is reached (clamped — no wraparound). Returns
 * the projected point at that arc-length offset, interpolated within the
 * final sub-segment if the walk lands mid-segment.
 */
function walkArc(
  coords: readonly [number, number][],
  i: number,
  arcM: number,
): [number, number] {
  const n = coords.length;
  const dir = arcM > 0 ? 1 : -1;
  let remaining = Math.abs(arcM);
  let cur = projPoint(coords[i]);
  let idx = i;
  while (remaining > 0) {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= n) break; // clamp at shape endpoint
    const next = projPoint(coords[nextIdx]);
    const segDx = next[0] - cur[0];
    const segDy = next[1] - cur[1];
    const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
    if (segLen === 0) { idx = nextIdx; continue; }
    if (segLen >= remaining) {
      const t = remaining / segLen;
      return [cur[0] + t * segDx, cur[1] + t * segDy];
    }
    remaining -= segLen;
    cur = next;
    idx = nextIdx;
  }
  return cur;
}

/**
 * Tangent at vertex `i` of `coords`, averaged over an arc-length window on
 * each side rather than read off a single raw vertex-to-vertex segment.
 * See TANGENT_WINDOW_M doc for why this matters. Degenerates gracefully
 * near shape endpoints (the walk simply clamps, shortening the window).
 */
function localTangent(
  coords: readonly [number, number][],
  i: number,
  windowM: number,
): { ux: number; uy: number } {
  const back = walkArc(coords, i, -windowM);
  const fwd = walkArc(coords, i, windowM);
  const dx = fwd[0] - back[0];
  const dy = fwd[1] - back[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { ux: 0, uy: 0 };
  return { ux: dx / len, uy: dy / len };
}

function pointSegDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

// ---- Segment spatial index ------------------------------------------

interface IndexedSeg {
  sx: number; sy: number;
  ex: number; ey: number;
  /** Pre-computed unit tangent (metres-per-metre), for direction-aware match. */
  ux: number; uy: number;
  /** Monotonically increasing id for the per-query dedup stamp. */
  id: number;
}

/**
 * Uniform-grid spatial index over line segments in metre-space.
 *
 * The per-query `seenStamp` array avoids per-call Set allocations:
 * each `hasWithin` call increments a global query counter and writes
 * that counter into the slot of every segment it tests, so
 * re-visiting a segment within the same query is detected in O(1).
 */
class SegmentIndex {
  private readonly cells = new Map<string, IndexedSeg[]>();
  private readonly cellSize: number;
  private segCount = 0;
  private seenStamp: Uint32Array = new Uint32Array(256);
  private queryCounter = 0;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  get size(): number { return this.segCount; }

  /**
   * `ux`/`uy` is the segment's tangent used for the direction gate — the
   * caller passes a locally-smoothed tangent (see `localTangent`) rather
   * than the raw endpoint-to-endpoint direction, so `add()` no longer
   * derives it internally.
   */
  add(sx: number, sy: number, ex: number, ey: number, ux: number, uy: number): void {
    const dx = ex - sx, dy = ey - sy;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return; // zero-length segments carry no spatial info
    const cs = this.cellSize;
    const minX = Math.min(sx, ex), maxX = Math.max(sx, ex);
    const minY = Math.min(sy, ey), maxY = Math.max(sy, ey);
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const y0 = Math.floor(minY / cs), y1 = Math.floor(maxY / cs);
    const id = this.segCount++;
    const ref: IndexedSeg = { sx, sy, ex, ey, ux, uy, id };
    if (id >= this.seenStamp.length) {
      const next = new Uint32Array(this.seenStamp.length * 2);
      next.set(this.seenStamp);
      this.seenStamp = next;
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x}:${y}`;
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(ref);
      }
    }
  }

  /**
   * True iff some indexed segment is within `maxDist` of (px, py) AND
   * either (a) within `fallbackSq` (squared), close enough to trust as
   * the same physical corridor regardless of tangent noise, or (b) its
   * tangent makes |cos(angle)| ≥ `cosMin` with (ux, uy). The direction
   * gate alone would falsely reject genuinely unchanged tight turns/loops
   * where feed A/B vertex density differs (see FALLBACK_M doc); the plain
   * proximity gate alone would falsely accept perpendicular cross-streets
   * at junctions (see COS_DIR_MIN doc). Combining both bounds each risk.
   */
  hasWithin(
    px: number, py: number,
    maxDist: number,
    ux: number, uy: number,
    cosMin: number,
    fallbackSq: number,
  ): boolean {
    const cs = this.cellSize;
    const reach = Math.ceil(maxDist / cs);
    const cx = Math.floor(px / cs);
    const cy = Math.floor(py / cs);
    const maxSq = maxDist * maxDist;
    let stamp = (this.queryCounter + 1) >>> 0;
    if (stamp === 0) {
      // Uint32 stamp wrap-around: clear all stamps so dedup remains exact.
      this.seenStamp.fill(0);
      stamp = 1;
    }
    this.queryCounter = stamp;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const s of bucket) {
          if (this.seenStamp[s.id] === stamp) continue;
          this.seenStamp[s.id] = stamp;
          const dSq = pointSegDistSq(px, py, s.sx, s.sy, s.ex, s.ey);
          if (dSq > maxSq) continue;
          if (dSq <= fallbackSq) return true;
          const dot = s.ux * ux + s.uy * uy;
          if (dot >= cosMin || dot <= -cosMin) return true;
        }
      }
    }
    return false;
  }
}

// ---- Public types ---------------------------------------------------

export type GeomStatus = 'unchanged' | 'added' | 'removed';

export interface DiffedRun {
  status: GeomStatus;
  coords: [number, number][];
  shape_id: string;
  route_id: string;
  feed: 'a' | 'b';
  modes: Mode[];
  primary_mode: Mode;
  /** Canonical route id this run was scoped to (see `diffShapesByRoute`). */
  canonicalId: string;
}

export interface DiffedShapes {
  feedA: string;
  feedB: string;
  runs: DiffedRun[];
}

export interface ShapeIndex {
  feedId: string;
  shapes: readonly ShapePolyline[];
  segmentCount: number;
  index: SegmentIndex;
}

// ---- Build & diff ---------------------------------------------------

export function buildShapeIndex(
  feedId: string,
  shapes: readonly ShapePolyline[],
): ShapeIndex {
  const index = new SegmentIndex(GRID_M);
  for (const sh of shapes) {
    const n = sh.coords.length;
    for (let i = 1; i < n; i++) {
      const [alon, alat] = sh.coords[i - 1];
      const [blon, blat] = sh.coords[i];
      const { ux, uy } = localTangent(sh.coords, i - 1, TANGENT_WINDOW_M);
      index.add(lonToX(alon), latToY(alat), lonToX(blon), latToY(blat), ux, uy);
    }
  }
  return { feedId, shapes, segmentCount: index.size, index };
}

export function diffShapes(a: ShapeIndex, b: ShapeIndex): DiffedShapes {
  const runs: DiffedRun[] = [];
  for (const sh of a.shapes) {
    classifyAndEmit(sh, b.index, 'a', (status, coords) => {
      runs.push({
        status, coords,
        shape_id: sh.shape_id, route_id: sh.route_id, feed: 'a',
        modes: sh.modes, primary_mode: sh.primary_mode, canonicalId: '',
      });
    });
  }
  for (const sh of b.shapes) {
    classifyAndEmit(sh, a.index, 'b', (status, coords) => {
      runs.push({
        status, coords,
        shape_id: sh.shape_id, route_id: sh.route_id, feed: 'b',
        modes: sh.modes, primary_mode: sh.primary_mode, canonicalId: '',
      });
    });
  }
  return { feedA: a.feedId, feedB: b.feedId, runs };
}

// ---- Route-scoped ("tube map") diff ----------------------------------
//
// `diffShapes` above compares one feed's ENTIRE shape set against the
// other's — feed-wide "is this street covered by any line?" semantics.
// That hides real changes: if Route 58 is removed but another surviving
// route shares its street, the street reads as `unchanged`. The functions
// below scope the same buffer-overlay computation to matched route pairs
// instead, so each line is compared only to its own counterpart across
// feeds — a "tube map" model. The underlying `buildShapeIndex`/`diffShapes`
// are reused unchanged; only the shape sets fed into them are scoped.

/**
 * A's and B's raw route_ids for one canonical route, as already computed
 * by the registry-driven route-identity matching (`diff/engine.ts`'s
 * `diffFeeds`). An empty side means that side has no counterpart — the
 * route was added or removed, not modified/renumbered/unchanged.
 */
export interface RoutePair {
  canonicalId: string;
  aRawIds: string[];
  bRawIds: string[];
}

/** route_id -> shapes owned by that route, deduped by shape_id per route. */
function shapesByRoute(
  shapes: readonly ShapePolyline[],
  shapeRouteMap: ReadonlyMap<string, string[]>,
): Map<string, ShapePolyline[]> {
  const byShapeId = new Map<string, ShapePolyline>();
  for (const sh of shapes) byShapeId.set(sh.shape_id, sh);
  const out = new Map<string, ShapePolyline[]>();
  for (const [shapeId, routeIds] of shapeRouteMap) {
    const sh = byShapeId.get(shapeId);
    if (!sh) continue;
    for (const rid of routeIds) {
      let arr = out.get(rid);
      if (!arr) { arr = []; out.set(rid, arr); }
      arr.push(sh);
    }
  }
  return out;
}

/** Union of shapes owned by any of `rawIds`, deduped by shape_id. */
function gatherShapes(
  byRoute: ReadonlyMap<string, ShapePolyline[]>,
  rawIds: readonly string[],
): ShapePolyline[] {
  const seen = new Set<string>();
  const out: ShapePolyline[] = [];
  for (const rid of rawIds) {
    const arr = byRoute.get(rid);
    if (!arr) continue;
    for (const sh of arr) {
      if (seen.has(sh.shape_id)) continue;
      seen.add(sh.shape_id);
      out.push(sh);
    }
  }
  return out;
}

/**
 * Buffer-overlay diff scoped per matched route pair instead of feed-wide.
 * For each pair with shapes on both sides, runs the existing
 * `buildShapeIndex`/`diffShapes` on just that route's own shapes. For a
 * pair with shapes on only one side (route added/removed, or a matched
 * route whose shapes.txt lookup came up empty on one side), every shape
 * is emitted directly as `added`/`removed` — there's no counterpart to
 * buffer-overlay against.
 *
 * A shape legitimately owned by two canonicals is gathered into both
 * pairs and so may be emitted twice (harmless on the map — same
 * geometry — but callers summing lengths must dedupe by shape_id; see
 * `segmentDiffToGeoJSON`).
 */
export function diffShapesByRoute(
  feedA: string,
  feedB: string,
  shapesA: readonly ShapePolyline[],
  shapesB: readonly ShapePolyline[],
  shapeRouteMapA: ReadonlyMap<string, string[]>,
  shapeRouteMapB: ReadonlyMap<string, string[]>,
  pairs: readonly RoutePair[],
): DiffedShapes {
  const byRouteA = shapesByRoute(shapesA, shapeRouteMapA);
  const byRouteB = shapesByRoute(shapesB, shapeRouteMapB);
  const runs: DiffedRun[] = [];

  for (const pair of pairs) {
    const aShapes = gatherShapes(byRouteA, pair.aRawIds);
    const bShapes = gatherShapes(byRouteB, pair.bRawIds);

    if (aShapes.length && bShapes.length) {
      const idxA = buildShapeIndex(feedA, aShapes);
      const idxB = buildShapeIndex(feedB, bShapes);
      const diffed = diffShapes(idxA, idxB);
      for (const run of diffed.runs) runs.push({ ...run, canonicalId: pair.canonicalId });
    } else if (aShapes.length) {
      for (const sh of aShapes) {
        runs.push({
          status: 'removed', coords: sh.coords,
          shape_id: sh.shape_id, route_id: sh.route_id, feed: 'a',
          modes: sh.modes, primary_mode: sh.primary_mode, canonicalId: pair.canonicalId,
        });
      }
    } else if (bShapes.length) {
      for (const sh of bShapes) {
        runs.push({
          status: 'added', coords: sh.coords,
          shape_id: sh.shape_id, route_id: sh.route_id, feed: 'b',
          modes: sh.modes, primary_mode: sh.primary_mode, canonicalId: pair.canonicalId,
        });
      }
    }
  }

  return { feedA, feedB, runs };
}

/**
 * Walk `shape` in arc-length steps, classify each sample against
 * `other`, and emit each maximal run of same-classified arc as a
 * sub-polyline.
 *
 *   - From the A side: pieces inside the other-feed buffer are
 *     `unchanged`; pieces outside are `removed`.
 *   - From the B side: pieces outside are `added`; pieces inside are
 *     *also* emitted, tagged `unchanged`, so a B-shape's runs still
 *     partition its whole length (needed to cross-reference route
 *     identity — see `segmentDiffToGeoJSON`'s `lineStatus`). The
 *     base "shared geometry" map layer only draws the A-side copy
 *     of `unchanged` (filtered on `feed === 'a'`) so this doesn't
 *     double-draw the same physical street.
 *
 * Each sample carries the unit tangent of the A-segment it sits on,
 * so the buffer test ignores B-segments that are merely close but
 * pointing the wrong way (e.g. a perpendicular cross-street meeting
 * A's segment at a junction).
 */
function classifyAndEmit(
  shape: ShapePolyline,
  other: SegmentIndex,
  feed: 'a' | 'b',
  emit: (status: GeomStatus, coords: [number, number][]) => void,
): void {
  const coords = shape.coords;
  const n = coords.length;
  if (n < 2) return;

  const statusFor = (inside: boolean): GeomStatus | null => {
    if (feed === 'a') return inside ? 'unchanged' : 'removed';
    return inside ? 'unchanged' : 'added';
  };

  // Run state: vertex list + classification + the most recent sample
  // point (`lastCoord`, `lastInside`). The last sample is *not*
  // always the last vertex — it can be an arc-length sub-step within
  // a long segment. `runInside` is computed lazily once we know the
  // first segment's direction (the starting vertex is classified with
  // the tangent of the segment leaving it).
  let runCoords: [number, number][] = [coords[0]];
  let runInside: boolean | null = null;
  let lastCoord = coords[0];
  let lastInside = false;

  for (let i = 1; i < n; i++) {
    const segStart = coords[i - 1];
    const segEnd = coords[i];
    const sxM = lonToX(segStart[0]);
    const syM = latToY(segStart[1]);
    const exM = lonToX(segEnd[0]);
    const eyM = latToY(segEnd[1]);
    const segDx = exM - sxM;
    const segDy = eyM - syM;
    const segMetric = Math.sqrt(segDx * segDx + segDy * segDy);
    // Degenerate (lon/lat-coincident) segments contribute no length
    // and no direction — keep walking with the previous classification.
    if (segMetric === 0) continue;
    const { ux, uy } = localTangent(coords, i - 1, TANGENT_WINDOW_M);

    if (runInside === null) {
      runInside = isInside(other, coords[0], ux, uy);
      lastInside = runInside;
    }

    const flipAt = (nextCoord: [number, number], nextInside: boolean) => {
      const cross = bsearchCrossing(lastCoord, nextCoord, other, lastInside, ux, uy);
      runCoords.push(cross);
      const s = statusFor(runInside!);
      if (s !== null && runCoords.length >= 2) emit(s, runCoords);
      runCoords = [cross];
      runInside = nextInside;
    };

    const segLen = haversineM(lastCoord[0], lastCoord[1], segEnd[0], segEnd[1]);

    // Long segments need intermediate sub-samples so we don't miss
    // mid-segment transitions. Sub-samples are *not* recorded as
    // vertices — they're only probe points to detect flips.
    if (segLen > STEP_M) {
      const numSteps = Math.ceil(segLen / STEP_M);
      for (let s = 1; s < numSteps; s++) {
        const t = s / numSteps;
        const sample: [number, number] = [
          lastCoord[0] + t * (segEnd[0] - lastCoord[0]),
          lastCoord[1] + t * (segEnd[1] - lastCoord[1]),
        ];
        const sampleInside = isInside(other, sample, ux, uy);
        if (sampleInside !== lastInside) flipAt(sample, sampleInside);
        lastCoord = sample;
        lastInside = sampleInside;
      }
    }

    // Process the actual segment-end vertex.
    const endInside = isInside(other, segEnd, ux, uy);
    if (endInside !== lastInside) flipAt(segEnd, endInside);
    runCoords.push(segEnd);
    lastCoord = segEnd;
    lastInside = endInside;
  }

  if (runInside === null) return; // shape collapsed to a single point
  const s = statusFor(runInside);
  if (s !== null && runCoords.length >= 2) emit(s, runCoords);
}

function isInside(
  idx: SegmentIndex,
  coord: [number, number],
  ux: number, uy: number,
): boolean {
  return idx.hasWithin(lonToX(coord[0]), latToY(coord[1]), TOL_M, ux, uy, COS_DIR_MIN, FALLBACK_SQ);
}

/**
 * Binary-search the crossing point on the straight line from `a` to
 * `b` between two probe samples of opposite classification. Returns
 * a coord on that line within sub-millimetre precision of the true
 * crossing. Both probe samples lie on the same A-segment, so we reuse
 * its tangent (ux, uy) for every direction-aware probe.
 */
function bsearchCrossing(
  a: [number, number], b: [number, number],
  other: SegmentIndex, aInside: boolean,
  ux: number, uy: number,
): [number, number] {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BSEARCH_ITERS; i++) {
    const mid = (lo + hi) / 2;
    const midCoord: [number, number] = [
      a[0] + mid * (b[0] - a[0]),
      a[1] + mid * (b[1] - a[1]),
    ];
    if (isInside(other, midCoord, ux, uy) === aInside) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

// ---- Length helper (used by segment-graph for sidebar totals) -------

export function lineLengthM(coords: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}
