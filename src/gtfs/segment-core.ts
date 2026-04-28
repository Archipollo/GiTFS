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

// ---- Local equirectangular projection (metres around Austria) -------

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

  add(sx: number, sy: number, ex: number, ey: number): void {
    const dx = ex - sx, dy = ey - sy;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return; // zero-length segments carry no spatial info
    const cs = this.cellSize;
    const minX = Math.min(sx, ex), maxX = Math.max(sx, ex);
    const minY = Math.min(sy, ey), maxY = Math.max(sy, ey);
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const y0 = Math.floor(minY / cs), y1 = Math.floor(maxY / cs);
    const len = Math.sqrt(len2);
    const id = this.segCount++;
    const ref: IndexedSeg = { sx, sy, ex, ey, ux: dx / len, uy: dy / len, id };
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
   * True iff some indexed segment is within `maxDist` of (px, py)
   * AND its tangent makes |cos(angle)| ≥ `cosMin` with (ux, uy).
   * Both tests are required — proximity alone falsely matches
   * perpendicular cross-streets at junctions.
   */
  hasWithin(
    px: number, py: number,
    maxDist: number,
    ux: number, uy: number,
    cosMin: number,
  ): boolean {
    const cs = this.cellSize;
    const reach = Math.ceil(maxDist / cs);
    const cx = Math.floor(px / cs);
    const cy = Math.floor(py / cs);
    const maxSq = maxDist * maxDist;
    const stamp = ++this.queryCounter;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const s of bucket) {
          if (this.seenStamp[s.id] === stamp) continue;
          this.seenStamp[s.id] = stamp;
          if (pointSegDistSq(px, py, s.sx, s.sy, s.ex, s.ey) > maxSq) continue;
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
  feed: 'a' | 'b';
  modes: Mode[];
  primary_mode: Mode;
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
      index.add(lonToX(alon), latToY(alat), lonToX(blon), latToY(blat));
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
        shape_id: sh.shape_id, feed: 'a',
        modes: sh.modes, primary_mode: sh.primary_mode,
      });
    });
  }
  for (const sh of b.shapes) {
    classifyAndEmit(sh, a.index, 'b', (status, coords) => {
      runs.push({
        status, coords,
        shape_id: sh.shape_id, feed: 'b',
        modes: sh.modes, primary_mode: sh.primary_mode,
      });
    });
  }
  return { feedA: a.feedId, feedB: b.feedId, runs };
}

/**
 * Walk `shape` in arc-length steps, classify each sample against
 * `other`, and emit each maximal run of same-classified arc as a
 * sub-polyline.
 *
 *   - From the A side: pieces inside the other-feed buffer are
 *     `unchanged`; pieces outside are `removed`.
 *   - From the B side: pieces outside are `added`; pieces inside
 *     are skipped (the same physical street is already drawn from
 *     the A side as `unchanged` to avoid double-drawing).
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
    return inside ? null : 'added';
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
    const ux = segDx / segMetric;
    const uy = segDy / segMetric;

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
  return idx.hasWithin(lonToX(coord[0]), latToY(coord[1]), TOL_M, ux, uy, COS_DIR_MIN);
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
