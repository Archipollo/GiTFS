// Segment-level line diff on GTFS shapes — the single spatial primitive
// used by the diff map layer and the accompanying sidebar totals.
//
// Motivation
// ----------
// GTFS `shapes.txt` is the agency's own digitisation of each physical
// trip path. Two feeds that describe the same street will have
// *different* polylines (different densification, different vertex
// placement, different start/end snap points), but they're still the
// ground truth we want to diff.
//
// The previous implementation resampled every shape at a fixed step and
// snapped each sample to a global grid cell, then diffed the resulting
// cell-edges as a set. That had two fatal problems:
//
//   1. The rendered geometry was a sequence of ~25 m straight chunks
//      between grid-cell centroids. It was *not* the shape from the
//      GTFS feed — it was a caricature of it. Visually wrong, and
//      analytically dishonest for a thesis tool that claims to show
//      what changed in the feed.
//   2. Choosing a grid size is lose-lose. Small cells re-introduce
//      fraying across feeds; large cells collapse genuinely parallel
//      streets into a single edge.
//
// This module replaces that with a straightforward "is this bit of
// shape A near any bit of shape B?" test that preserves original
// vertices everywhere:
//
//   * Build a spatial index over every B polyline *segment* (a line
//     segment between two consecutive vertices), so we can cheaply
//     answer "is there a B segment within TOL_M of this point?".
//   * For each A polyline, classify every vertex as on-B / off-B by
//     point-to-segment distance against that index. A short-run
//     smoothing pass kills single-vertex jitter from digitisation
//     noise without merging neighbouring runs that are genuinely
//     different.
//   * Emit consecutive same-class vertices as a run. Runs share the
//     transition vertex so the rendered line remains continuous.
//     `removed` runs come from A; `added` and `unchanged` runs come
//     from B. Unchanged runs are never emitted from A to avoid double
//     drawing the same physical street twice.
//
// The rendered LineStrings are literally the GTFS shape coordinates,
// sliced at vertex boundaries. Nothing is invented.
//
// Caveats
// -------
// Transitions land on the nearest vertex, so a run boundary may sit
// slightly before/after the "true" shared/unshared boundary — bounded
// by the local vertex density of the shape. GTFS shapes tend to be
// densely sampled (5–30 m) in built-up areas, so this is imperceptible
// at the zoom levels the tool is used at.
//
// TOL_M governs what counts as "same street". Too small and minor
// digitisation jitter between feeds shows up as huge swaths of
// added+removed geometry. Too large and genuinely parallel nearby
// streets get merged. 35 m is a reasonable middle for Austrian GTFS
// feeds — wider than typical jitter, narrower than any two distinct
// urban streets.

import { type Mode, MODES } from './modes';
import { fetchShapes, type ShapePolyline } from './queries';

// ---- Algorithm parameters -------------------------------------------

/**
 * Max distance (metres) between an A-vertex and any B segment for the
 * vertex to count as "also present in B". Absorbs cross-feed
 * digitisation jitter; must be comfortably smaller than the separation
 * between parallel streets.
 */
const TOL_M = 35;

/**
 * Runs shorter than this (in metres of arc length) that are sandwiched
 * between two runs of the opposite class get flipped. Prevents a single
 * noisy vertex from carving an added/removed sliver out of an otherwise
 * shared street.
 */
const MIN_RUN_M = 40;

/**
 * Grid cell size for the segment index. Chosen as 2 × TOL_M so any
 * point that could possibly hit a segment is covered by its immediate
 * 3×3 neighbourhood of cells in the worst case.
 */
const GRID_M = TOL_M * 2;

// ---- Local equirectangular projection (metres around Austria) ------

const LAT_REF = 47.5;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT_REF * Math.PI) / 180);

function lonToX(lon: number): number { return lon * M_PER_DEG_LON; }
function latToY(lat: number): number { return lat * M_PER_DEG_LAT; }

const EARTH_R = 6_371_000;
function haversineM(aLon: number, aLat: number, bLon: number, bLat: number): number {
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

/** A single segment stored in the index, in metre-space. */
interface IndexedSeg {
  sx: number; sy: number;
  ex: number; ey: number;
}

/**
 * Uniform-grid spatial index over line segments. Each segment is
 * registered into every grid cell its bounding box intersects, so a
 * point-query only has to scan nearby cells. Simple and plenty fast
 * for the feed sizes this tool targets.
 */
class SegmentIndex {
  private readonly cells = new Map<string, IndexedSeg[]>();
  private readonly cellSize: number;
  private segCount = 0;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  get size(): number { return this.segCount; }

  add(sx: number, sy: number, ex: number, ey: number): void {
    const cs = this.cellSize;
    const minX = Math.min(sx, ex), maxX = Math.max(sx, ex);
    const minY = Math.min(sy, ey), maxY = Math.max(sy, ey);
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const y0 = Math.floor(minY / cs), y1 = Math.floor(maxY / cs);
    const ref: IndexedSeg = { sx, sy, ex, ey };
    this.segCount++;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x}:${y}`;
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(ref);
      }
    }
  }

  /** True iff some indexed segment is within `maxDist` of (px, py). */
  hasWithin(px: number, py: number, maxDist: number): boolean {
    const cs = this.cellSize;
    const reach = Math.ceil(maxDist / cs);
    const cx = Math.floor(px / cs);
    const cy = Math.floor(py / cs);
    const maxSq = maxDist * maxDist;
    // A segment may appear in multiple cells; guard with a per-query
    // seen-set to avoid redundant distance tests on long segments that
    // straddle many cells.
    const seen = new Set<IndexedSeg>();
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const s of bucket) {
          if (seen.has(s)) continue;
          seen.add(s);
          if (pointSegDistSq(px, py, s.sx, s.sy, s.ex, s.ey) <= maxSq) return true;
        }
      }
    }
    return false;
  }
}

// ---- Public types ---------------------------------------------------

/**
 * Per-feed artefact: the feed's original shapes plus a spatial index
 * over their segments. Computed once per feed and cached below.
 */
export interface ShapeIndex {
  feedId: string;
  shapes: readonly ShapePolyline[];
  /** Total segment count in the index; handy for logging. */
  segmentCount: number;
  /** Internal index — intentionally not exposed by interface members. */
  index: SegmentIndex;
}

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

// ---- Per-feed async cache -------------------------------------------

const indexCache = new Map<string, Promise<ShapeIndex>>();

/**
 * Shared cache for per-feed shape indexes. Fetches the feed's shapes
 * (already cached itself via DuckDB) and builds the index once.
 */
export function getShapeIndex(feedId: string): Promise<ShapeIndex> {
  const hit = indexCache.get(feedId);
  if (hit) return hit;
  const p = (async () => {
    const shapes = await fetchShapes(feedId);
    return buildShapeIndex(feedId, shapes);
  })().catch((err) => {
    indexCache.delete(feedId);
    throw err;
  });
  indexCache.set(feedId, p);
  return p;
}

/** Invalidate cached indexes (e.g. when a feed is removed). */
export function dropShapeIndex(feedId: string): void {
  indexCache.delete(feedId);
}

// ---- Diff -----------------------------------------------------------

/**
 * Classification of a polyline run (a maximal consecutive sub-path of
 * original shape vertices sharing a class) in an A→B diff.
 */
export type GeomStatus = 'unchanged' | 'added' | 'removed';

/** Palette shared by the diff map layers and the sidebar swatches. */
export const SEGMENT_COLOR: Record<GeomStatus, string> = {
  added: '#16a34a', // green-600
  removed: '#dc2626', // red-600
  unchanged: '#94a3b8', // slate-400
};

export interface DiffedRun {
  status: GeomStatus;
  /** Original shape vertices for this run. At least two points. */
  coords: [number, number][];
  /** Shape this run was sliced from. */
  shape_id: string;
  /** Which feed supplied the geometry: 'a' for removed; 'b' for added/unchanged. */
  feed: 'a' | 'b';
  modes: Mode[];
  primary_mode: Mode;
}

export interface DiffedShapes {
  feedA: string;
  feedB: string;
  runs: DiffedRun[];
}

/**
 * Diff two shape indexes by classifying each vertex of each polyline
 * against the other feed's segment index.
 *
 *   - `removed` runs: A polylines where the local vertex isn't on B
 *   - `added` runs:   B polylines where the local vertex isn't on A
 *   - `unchanged` runs: B polylines where the local vertex is on A.
 *     Picking B here (instead of also emitting the A equivalent) keeps
 *     shared trackage from being drawn twice. The rendered line is
 *     still GTFS-verbatim, just from the current feed.
 */
export function diffShapes(a: ShapeIndex, b: ShapeIndex): DiffedShapes {
  const runs: DiffedRun[] = [];
  // A side → only emit `removed` (off-B) runs; unchanged handled below.
  for (const sh of a.shapes) {
    classifyPolyline(sh, b.index, (onOther, coords) => {
      if (onOther) return; // `unchanged` comes from B
      runs.push({
        status: 'removed',
        coords,
        shape_id: sh.shape_id,
        feed: 'a',
        modes: sh.modes,
        primary_mode: sh.primary_mode,
      });
    });
  }
  // B side → `unchanged` if on A, else `added`.
  for (const sh of b.shapes) {
    classifyPolyline(sh, a.index, (onOther, coords) => {
      runs.push({
        status: onOther ? 'unchanged' : 'added',
        coords,
        shape_id: sh.shape_id,
        feed: 'b',
        modes: sh.modes,
        primary_mode: sh.primary_mode,
      });
    });
  }
  return { feedA: a.feedId, feedB: b.feedId, runs };
}

/**
 * Classify vertices of a shape against `otherIndex`, smooth short-run
 * jitter, and emit each maximal run of same-class vertices as a
 * contiguous sub-polyline using the shape's own coordinates. Transition
 * vertices are shared between consecutive runs so the drawn line stays
 * continuous without gaps or overlaps longer than one vertex.
 */
function classifyPolyline(
  shape: ShapePolyline,
  otherIndex: SegmentIndex,
  emit: (onOther: boolean, coords: [number, number][]) => void,
): void {
  const coords = shape.coords;
  const n = coords.length;
  if (n < 2) return;

  // 1. vertex-level classification
  const onOther = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const [lon, lat] = coords[i];
    onOther[i] = otherIndex.hasWithin(lonToX(lon), latToY(lat), TOL_M);
  }

  // 2. segment lengths (metres) for run-length smoothing
  const segLen = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    segLen[i] = haversineM(
      coords[i][0], coords[i][1],
      coords[i + 1][0], coords[i + 1][1],
    );
  }

  smoothShortRuns(onOther, segLen);

  // 3. run-walk. We want consecutive runs to share the transition vertex
  //    so the drawn LineString stays visually continuous.
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    const atEnd = i === n;
    if (atEnd || onOther[i] !== onOther[runStart]) {
      // Slice [runStart, i] inclusive when possible, so the run extends
      // up to (but not past) the first vertex of the next run.
      const sliceEnd = atEnd ? n - 1 : i;
      const slice = coords.slice(runStart, sliceEnd + 1);
      if (slice.length >= 2) emit(onOther[runStart], slice);
      runStart = i;
    }
  }
}

/**
 * Iteratively flip short middle runs whose length is below MIN_RUN_M
 * and which are bordered on both sides by opposite-class runs. This
 * kills one- and two-vertex noise spikes from digitisation jitter
 * without ever merging two runs of the *same* class at a legitimate
 * boundary.
 *
 * Terminal (first/last) runs are left alone — they're often legitimate
 * short spurs where a bus depot hook or a layover loop extends past the
 * shared trunk, and we don't want to erase them.
 */
function smoothShortRuns(onOther: boolean[], segLen: readonly number[]): void {
  const n = onOther.length;
  if (n < 3) return;

  // Guard against pathological shape data triggering a long smoothing
  // loop — we expect at most a handful of passes to fully converge.
  for (let pass = 0; pass < 8; pass++) {
    const runs = findRuns(onOther, segLen);
    let changed = false;
    for (let r = 1; r < runs.length - 1; r++) {
      const run = runs[r];
      if (run.lenM >= MIN_RUN_M) continue;
      if (runs[r - 1].cls === run.cls || runs[r + 1].cls === run.cls) continue;
      // Flip every vertex in the run.
      for (let i = run.start; i <= run.end; i++) onOther[i] = !onOther[i];
      changed = true;
    }
    if (!changed) return;
  }
}

interface Run { start: number; end: number; cls: boolean; lenM: number; }

function findRuns(onOther: boolean[], segLen: readonly number[]): Run[] {
  const runs: Run[] = [];
  const n = onOther.length;
  let s = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || onOther[i] !== onOther[s]) {
      let lenM = 0;
      for (let j = s; j < i - 1; j++) lenM += segLen[j];
      runs.push({ start: s, end: i - 1, cls: onOther[s], lenM });
      s = i;
    }
  }
  return runs;
}

// ---- GeoJSON emitter -------------------------------------------------

/** Length (metres) summary used by the diff sidebar swatches. */
export interface SegmentLengths {
  added: number;
  removed: number;
  unchanged: number;
}

export interface SegmentDiff {
  features: GeoJSON.FeatureCollection;
  lengths: SegmentLengths;
}

function modeFlags(modes: readonly Mode[]): Record<string, boolean> {
  const effective = modes.length ? modes : (['other'] as Mode[]);
  const flags: Record<string, boolean> = {};
  for (const m of MODES) flags[`is_${m}`] = (effective as readonly Mode[]).includes(m);
  return flags;
}

function runLengthM(coords: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(
      coords[i - 1][0], coords[i - 1][1],
      coords[i][0], coords[i][1],
    );
  }
  return total;
}

/**
 * Diff-mode GeoJSON: one LineString per classified run, using the
 * original shape vertices. Returns per-status length totals alongside,
 * computed before visibility filtering so the sidebar "X km" numbers
 * don't change when layers are toggled.
 *
 * `accept` is applied to both features *and* lengths, so mode-filter
 * toggles keep the two in lock-step.
 */
export function segmentDiffToGeoJSON(
  diff: DiffedShapes,
  visibility: Record<GeomStatus, boolean>,
  accept: (r: DiffedRun) => boolean = () => true,
): SegmentDiff {
  const features: GeoJSON.Feature[] = [];
  const lengths: SegmentLengths = { added: 0, removed: 0, unchanged: 0 };
  for (const run of diff.runs) {
    if (!accept(run)) continue;
    lengths[run.status] += runLengthM(run.coords);
    if (!visibility[run.status]) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: run.coords },
      properties: {
        geom_status: run.status,
        shape_id: run.shape_id,
        feed: run.feed,
        primary_mode: run.primary_mode,
        ...modeFlags(run.modes),
      },
    });
  }
  return { features: { type: 'FeatureCollection', features }, lengths };
}

/**
 * Utility for the route-inspector "click a diff segment" path: given a
 * feature clicked on the map, return the feed it came from and its
 * original shape id. Callers resolve shape → route themselves so this
 * module stays free of registry concerns.
 */
export interface ClickedRunRef {
  feedId: string;
  shapeId: string;
}

export function resolveClickedRun(
  props: Record<string, unknown>,
  feedA: string,
  feedB: string,
): ClickedRunRef | null {
  const feed = String(props.feed ?? '');
  const shapeId = String(props.shape_id ?? '');
  if (!shapeId) return null;
  if (feed === 'a') return { feedId: feedA, shapeId };
  if (feed === 'b') return { feedId: feedB, shapeId };
  return null;
}
