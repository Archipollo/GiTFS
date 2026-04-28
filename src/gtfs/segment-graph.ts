// Caching + worker layer on top of the buffer-overlay diff in
// `segment-core.ts`.
//
// The pure GIS computation (turf.buffer / lineSplit / booleanPointInPolygon)
// runs inside a Web Worker so the main thread stays responsive while
// the diff is being built. Results are cached per (feedA, feedB) pair
// so toggling visibility filters only re-runs the cheap GeoJSON emit
// pass on the main thread.

import { type Mode, MODES } from './modes';
import { fetchShapes } from './queries';
import {
  buildShapeIndex,
  diffShapes,
  lineLengthM,
  type DiffedRun,
  type DiffedShapes,
  type GeomStatus,
  type ShapeIndex,
} from './segment-core';

// Re-export types and pure computation for consumers that don't need
// the caching layer (e.g. tests, the worker itself).
export type { DiffedRun, DiffedShapes, GeomStatus, ShapeIndex };
export { buildShapeIndex, diffShapes };

/** Palette shared by the diff map layers and the sidebar swatches. */
export const SEGMENT_COLOR: Record<GeomStatus, string> = {
  added: '#16a34a',    // green-600
  removed: '#dc2626',  // red-600
  unchanged: '#475569', // slate-600
};

// ---- Per-feed shape cache ------------------------------------------

const indexCache = new Map<string, Promise<ShapeIndex>>();

/**
 * Cached per-feed shape fetch. The returned `ShapeIndex` is
 * intentionally thin (just `{feedId, shapes}`) — the heavy buffer
 * polygons are built inside the worker, off the main thread.
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

/** Invalidate a feed's shape cache (e.g. when the feed is removed). */
export function dropShapeIndex(feedId: string): void {
  indexCache.delete(feedId);
}

// ---- Off-main-thread diff via Web Worker ---------------------------

let _worker: Worker | null = null;
let _msgId = 0;
const _pending = new Map<number, {
  resolve: (d: DiffedShapes) => void;
  reject: (e: Error) => void;
}>();

function getDiffWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./diff-worker.ts', import.meta.url), { type: 'module' });
  _worker.onmessage = (e: MessageEvent) => {
    const { id, runs, feedA, feedB } = e.data;
    const cb = _pending.get(id);
    if (!cb) return;
    _pending.delete(id);
    cb.resolve({ feedA, feedB, runs });
  };
  _worker.onerror = (err) => {
    const error = new Error(`diff worker error: ${err.message ?? String(err)}`);
    for (const cb of _pending.values()) cb.reject(error);
    _pending.clear();
    _worker = null; // reset so the next call spawns a fresh worker
  };
  return _worker;
}

// ---- Pair-level diff cache -----------------------------------------

const diffCache = new Map<string, Promise<DiffedShapes>>();

/**
 * Compute and cache the buffer-overlay diff for a feed pair. The
 * expensive GIS work runs in a Web Worker so the main thread stays
 * responsive. Calling again with the same (feedA, feedB) pair returns
 * the cached Promise immediately — even while the first computation
 * is still in flight — so React effects that fire multiple times
 * never duplicate the work.
 */
export function getDiffedShapes(idxA: ShapeIndex, idxB: ShapeIndex): Promise<DiffedShapes> {
  const key = `${idxA.feedId}:${idxB.feedId}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const p = new Promise<DiffedShapes>((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve, reject });
    getDiffWorker().postMessage({
      id,
      feedA: idxA.feedId,
      feedB: idxB.feedId,
      // Structured-clone the shapes to the worker (serialisable plain objects).
      shapesA: idxA.shapes,
      shapesB: idxB.shapes,
    });
  }).catch((err) => {
    diffCache.delete(key);
    throw err;
  });
  diffCache.set(key, p);
  return p;
}

/**
 * Invalidate all cached diffs that involve `feedId`. Call this
 * alongside `dropShapeIndex` whenever a feed is removed so a later
 * re-ingest of the same id doesn't reuse stale geometry.
 */
export function dropDiffCache(feedId: string): void {
  for (const key of [...diffCache.keys()]) {
    if (key.startsWith(`${feedId}:`) || key.endsWith(`:${feedId}`)) {
      diffCache.delete(key);
    }
  }
}

// ---- GeoJSON emitter -----------------------------------------------

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

/**
 * Diff-mode GeoJSON: one LineString per classified run, using the
 * original shape vertices (plus at most one interpolated vertex per
 * buffer-boundary crossing). Returns per-status length totals
 * alongside, computed before visibility filtering so the sidebar
 * "X km" numbers don't change when layers are toggled.
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
    lengths[run.status] += lineLengthM(run.coords);
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
 * original shape id.
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
