// Caching + worker layer on top of the buffer-overlay diff in
// `segment-core.ts`.
//
// The pure GIS computation (turf.buffer / lineSplit / booleanPointInPolygon)
// runs inside a Web Worker so the main thread stays responsive while
// the diff is being built. Results are cached per (feedA, feedB) pair
// so toggling visibility filters only re-runs the cheap GeoJSON emit
// pass on the main thread.

import { type Mode, MODES } from './modes';
import { fetchShapes, fetchShapeRouteMap, fetchShapeDirectionMap } from './queries';
import {
  buildShapeIndex,
  diffShapes,
  lineLengthM,
  type DiffedRun,
  type DiffedShapes,
  type GeomStatus,
  type RoutePair,
} from './segment-core';
import type { ShapePolyline } from './queries';
import type { DiffResult } from '../diff/engine';

// Re-export types and pure computation for consumers that don't need
// the caching layer (e.g. tests, the worker itself).
export type { DiffedRun, DiffedShapes, GeomStatus, RoutePair, ShapeIndex } from './segment-core';
export { buildShapeIndex, diffShapes };

/**
 * Map each canonical route from the entity diff to the raw route_ids that
 * scope its "tube map" geometry comparison. An empty side means that side
 * has no counterpart (route added/removed) — `diffShapesByRoute` treats
 * that as a trivial whole-shape added/removed, no buffer-overlay needed.
 */
export function buildRoutePairs(result: DiffResult): RoutePair[] {
  return result.routes.map((entry) => ({
    canonicalId: entry.canonicalId,
    aRawIds: entry.a?.rawIds ?? [],
    bRawIds: entry.b?.rawIds ?? [],
  }));
}

/** Palette shared by the diff map layers and the sidebar swatches. */
export const SEGMENT_COLOR: Record<GeomStatus, string> = {
  added: '#2ecc71',
  removed: '#e74c3c',
  unchanged: '#9aa0a6',
  changed: '#f1c40f',
};

// ---- Per-feed shape cache ------------------------------------------

export interface FeedShapes {
  feedId: string;
  shapes: readonly ShapePolyline[];
  /** shape_id -> route_id[] membership (many-to-many; see `fetchShapeRouteMap`). */
  shapeRouteMap: Map<string, string[]>;
  /** shape_id -> dominant direction_id, `-1` when the feed has none. Scopes
   *  the diff to one direction at a time; see `diffShapesByRoute`. */
  shapeDirectionMap: Map<string, number>;
}

const indexCache = new Map<string, Promise<FeedShapes>>();

/**
 * Cached per-feed shape fetch. This intentionally returns only plain
 * data (shapes + shape/route membership) so the heavy segment index
 * build stays off the main thread inside the worker.
 */
export function getShapeIndex(feedId: string): Promise<FeedShapes> {
  const hit = indexCache.get(feedId);
  if (hit) return hit;
  const p = (async () => {
    const [shapes, shapeRouteMap, shapeDirectionMap] = await Promise.all([
      fetchShapes(feedId),
      fetchShapeRouteMap(feedId),
      fetchShapeDirectionMap(feedId),
    ]);
    return { feedId, shapes, shapeRouteMap, shapeDirectionMap } as FeedShapes;
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

interface DiffCacheEntry {
  /** Registry snapshot version the route pairs were computed from — a
   *  registry rebuild (re-matching) invalidates the entry even though
   *  (feedA, feedB) haven't changed. */
  registryBuiltAt: number;
  promise: Promise<DiffedShapes>;
}

const diffCache = new Map<string, Map<string, DiffCacheEntry>>();

/**
 * Compute and cache the route-scoped buffer-overlay diff for a feed
 * pair. The expensive GIS work runs in a Web Worker so the main thread
 * stays responsive. Calling again with the same (feedA, feedB) pair and
 * registry version returns the cached Promise immediately — even while
 * the first computation is still in flight — so React effects that fire
 * multiple times never duplicate the work. `pairs` is the route-identity
 * correspondence from `buildRoutePairs`/the entity diff — see
 * `diffShapesByRoute` in segment-core.ts for how it scopes the diff.
 */
export function getDiffedShapes(
  idxA: FeedShapes,
  idxB: FeedShapes,
  pairs: readonly RoutePair[],
  registryBuiltAt: number,
): Promise<DiffedShapes> {
  let byB = diffCache.get(idxA.feedId);
  if (!byB) {
    byB = new Map<string, DiffCacheEntry>();
    diffCache.set(idxA.feedId, byB);
  }
  const hit = byB.get(idxB.feedId);
  if (hit && hit.registryBuiltAt === registryBuiltAt) return hit.promise;

  let selfRef!: Promise<DiffedShapes>;
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
      shapeRouteMapA: [...idxA.shapeRouteMap],
      shapeRouteMapB: [...idxB.shapeRouteMap],
      shapeDirMapA: [...idxA.shapeDirectionMap],
      shapeDirMapB: [...idxB.shapeDirectionMap],
      pairs,
    });
  }).catch((err) => {
    const mapForA = diffCache.get(idxA.feedId);
    if (mapForA?.get(idxB.feedId)?.promise === selfRef) {
      mapForA.delete(idxB.feedId);
      if (mapForA.size === 0) diffCache.delete(idxA.feedId);
    }
    throw err;
  });
  selfRef = p;
  byB.set(idxB.feedId, { registryBuiltAt, promise: p });
  return p;
}

/**
 * Invalidate all cached diffs that involve `feedId`. Call this
 * alongside `dropShapeIndex` whenever a feed is removed so a later
 * re-ingest of the same id doesn't reuse stale geometry.
 */
export function dropDiffCache(feedId: string): void {
  diffCache.delete(feedId);
  for (const [feedA, byB] of diffCache) {
    byB.delete(feedId);
    if (byB.size === 0) diffCache.delete(feedA);
  }
}

// ---- GeoJSON emitter -----------------------------------------------

/** Length (metres) summary used by the diff sidebar swatches. */
export interface SegmentLengths {
  added: number;
  removed: number;
  unchanged: number;
  changed: number;
}

/**
 * Full shape length (metres) of routes whose *identity* was removed/added,
 * regardless of whether their corridor is still physically covered by
 * another route (in which case `SegmentLengths` would classify most of it
 * as `unchanged`). Driven by `lineStatus` in `segmentDiffToGeoJSON`.
 */
export interface RouteLineLengths {
  removed: number;
  added: number;
}

export interface SegmentDiff {
  features: GeoJSON.FeatureCollection;
  lengths: SegmentLengths;
  routeLengths: RouteLineLengths;
}

/**
 * `accept` predicate keeping exactly one copy of each shared corridor.
 *
 * `unchanged` runs are emitted from both feeds for the same physical
 * stretch (see `classifyAndEmit`), so a view that draws both gets two
 * near-identical overlapping lines. Views that show a single combined
 * picture (network, split panes) want the A-side copy; a view showing the
 * *new* network wants the B-side one. The layers themselves no longer
 * filter by feed — drawing the wrong side used to blank the unchanged
 * geometry entirely, leaving a route as disconnected fragments.
 */
export function preferFeed(side: 'a' | 'b'): (r: DiffedRun) => boolean {
  return (r) => (r.status === 'unchanged' ? r.feed === side : true);
}

/**
 * Network-scale `accept` predicate: `preferFeed('a')`, except on routes that
 * were rerouted, where *both* unchanged copies are kept.
 *
 * Each feed's runs are splits of that feed's own polyline, so a B-side
 * `changed` run's continuation is the B-side unchanged copy. Dropping it (as
 * plain `preferFeed('a')` does) leaves the yellow reroute ending in mid-air,
 * up to TOL_M from the surviving A-side copy — the same discontinuity
 * `RouteDetailView` avoids by accepting both feeds in colored mode. Scoping
 * the overdraw to rerouted routes buys that continuity without doubling the
 * grey network everywhere.
 */
export function preferFeedKeepingReroutes(
  diff: DiffedShapes,
  side: 'a' | 'b' = 'a',
): (r: DiffedRun) => boolean {
  const rerouted = new Set<string>();
  for (const run of diff.runs) {
    if (run.status === 'changed') rerouted.add(run.canonicalId);
  }
  return (r) => {
    if (r.status !== 'unchanged') return true;
    return r.feed === side || rerouted.has(r.canonicalId);
  };
}

/** 'removed' | 'added' route-identity status for the route owning a run, or
 * null if that route's identity is unchanged/modified/renumbered. */
export type RunLineStatus = 'removed' | 'added' | null;

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
 *
 * `lineStatus`, if given, looks up the route-*identity* status (removed/
 * added/null) of the route that owns each run — independent of `geom_status`,
 * which only reflects whether the physical corridor is still covered by
 * *some* route. A run can be `geom_status: 'unchanged'` (its street is still
 * served) while `lineStatus` says `'removed'` (this particular route is
 * gone) — e.g. one of two lines sharing a street was cut. `routeLengths`
 * sums each run's full shape length by that identity status, so a fully-cut
 * route counts its whole length as removed even though most of its corridor
 * reads `unchanged` in `lengths`.
 *
 * A shape legitimately owned by two canonical routes is diffed once per
 * canonical (see `diffShapesByRoute`) and so can appear twice with an
 * identical run (same feed/shape_id/status/start/end). `lengthKey`
 * dedupes exact-duplicate runs (skipped from both lengths and features)
 * while still separately counting/drawing genuinely distinct same-status
 * runs on one shape (e.g. an unchanged-removed-unchanged split has two
 * different unchanged runs with different bounds).
 */
function lengthKey(run: DiffedRun): string {
  const first = run.coords[0];
  const last = run.coords[run.coords.length - 1];
  return `${run.feed}\t${run.shape_id}\t${run.status}\t${first[0]},${first[1]}\t${last[0]},${last[1]}`;
}

export function segmentDiffToGeoJSON(
  diff: DiffedShapes,
  visibility: Record<GeomStatus, boolean>,
  accept: (r: DiffedRun) => boolean = () => true,
  lineStatus: (r: DiffedRun) => RunLineStatus = () => null,
): SegmentDiff {
  const features: GeoJSON.Feature[] = [];
  const lengths: SegmentLengths = { added: 0, removed: 0, unchanged: 0, changed: 0 };
  const routeLengths: RouteLineLengths = { added: 0, removed: 0 };
  const seenLength = new Set<string>();
  for (const run of diff.runs) {
    if (!accept(run)) continue;
    const lk = lengthKey(run);
    const isDupe = seenLength.has(lk);
    if (!isDupe) seenLength.add(lk);
    // `unchanged` runs are emitted from both feeds for the same physical
    // corridor (see classifyAndEmit) so route identity can be
    // cross-referenced on the B side too; only count the A-side copy here
    // to avoid doubling the "shared geometry" length total. `changed`
    // runs are similarly emitted as an old/new pair for one reroute —
    // only the new-side length counts, so a rerouted stretch reads as
    // "X km changed" rather than the old+new sum inflating the figure.
    const countsTowardLength =
      run.status === 'unchanged' ? run.feed === 'a'
      : run.status === 'changed' ? run.changedSide === 'new'
      : true;
    if (!isDupe && countsTowardLength) {
      lengths[run.status] += lineLengthM(run.coords);
    }
    const ls = lineStatus(run);
    if (ls && !isDupe) routeLengths[ls] += lineLengthM(run.coords);
    if (!visibility[run.status]) continue;
    if (isDupe) continue; // avoid drawing the same duplicate-owned-shape run twice
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: run.coords },
      properties: {
        geom_status: run.status,
        changed_side: run.changedSide ?? null,
        line_status: ls ?? 'none',
        shape_id: run.shape_id,
        route_id: run.route_id,
        // The canonical route this run was diffed under (route-scoped diff)
        // — authoritative for click-to-focus, since a shape shared by
        // several routes is ambiguous to resolve after the fact.
        canonical_id: run.canonicalId,
        feed: run.feed,
        primary_mode: run.primary_mode,
        ...modeFlags(run.modes),
      },
    });
  }
  return { features: { type: 'FeatureCollection', features }, lengths, routeLengths };
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
