// Orchestrator for IR-level feed diffs.
//
// Responsibilities:
//   1. Fetch the raw stops/routes for feeds A and B (DuckDB-backed).
//   2. Hand them to the pure `diffFeeds` engine along with the current
//      registry snapshot.
//   3. Cache the resulting `DiffResult` per (A,B) pair and per registry
//      version so repeated view switches don't re-run the pipeline.
//   4. Expose a pub/sub surface so React components can re-render when a
//      diff becomes available.
//
// Ordering of feeds matters: diff(A→B) is the user-facing "what changed
// from A to B?" — we do NOT treat (A,B) and (B,A) as the same cache key.

import { fetchRawRoutes, fetchRawStops } from '../registry/queries';
import { getRegistry, subscribeRegistry, type RegistrySnapshot } from '../registry/registry';
import { useAppStore } from '../state/app-store';
import {
  diffFeeds,
  type DiffResult,
  type StopDiffEntry,
  type RouteDiffEntry,
} from './engine';

interface CacheEntry {
  key: string;
  registryBuiltAt: number;
  result: DiffResult;
  /** Per-feed raw-id -> DiffResult entry, for O(1) lookup during map rendering. */
  stopIndex: {
    a: Map<string, StopDiffEntry>;
    b: Map<string, StopDiffEntry>;
  };
  routeIndex: {
    a: Map<string, RouteDiffEntry>;
    b: Map<string, RouteDiffEntry>;
  };
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DiffResult>>();
const listeners = new Set<() => void>();
let taskSeq = 0;

function emit() {
  for (const l of listeners) l();
}

/**
 * Invalidate all cached diffs; called when the registry is rebuilt.
 *
 * We also drop the `inflight` entries so a subsequent `getOrComputeDiff`
 * call doesn't re-use a promise whose work is racing against a stale
 * registry snapshot. The old promises keep running until they observe the
 * snapshot change themselves (see the guard in the work task below), at
 * which point they bail out instead of polluting the cache.
 */
function invalidateAll() {
  if (cache.size === 0 && inflight.size === 0) return;
  cache.clear();
  inflight.clear();
  emit();
}

let registrySubscribed = false;
function ensureRegistrySub() {
  if (registrySubscribed) return;
  registrySubscribed = true;
  subscribeRegistry(invalidateAll);
}

export function subscribeDiff(l: () => void): () => void {
  ensureRegistrySub();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function keyFor(a: string, b: string): string {
  return `${a}\u0001${b}`;
}

function buildIndexes(result: DiffResult): CacheEntry['stopIndex'] & {
  _routes: CacheEntry['routeIndex'];
} {
  const aStops = new Map<string, StopDiffEntry>();
  const bStops = new Map<string, StopDiffEntry>();
  for (const e of result.stops) {
    if (e.a) for (const id of e.a.rawIds) aStops.set(id, e);
    if (e.b) for (const id of e.b.rawIds) bStops.set(id, e);
  }
  const aRoutes = new Map<string, RouteDiffEntry>();
  const bRoutes = new Map<string, RouteDiffEntry>();
  for (const e of result.routes) {
    if (e.a) for (const id of e.a.rawIds) aRoutes.set(id, e);
    if (e.b) for (const id of e.b.rawIds) bRoutes.set(id, e);
  }
  // Pack into a two-shape object the caller destructures.
  return Object.assign(
    { a: aStops, b: bStops },
    { _routes: { a: aRoutes, b: bRoutes } },
  );
}

/**
 * Compute the diff for (feedA, feedB), or return the cached one. If the
 * registry has been rebuilt since the last cache hit the entry is dropped
 * and recomputed.
 */
export async function getOrComputeDiff(feedA: string, feedB: string): Promise<DiffResult> {
  const registry = getRegistry();
  if (!registry) {
    throw new Error('Registry not built yet — build it before computing a diff.');
  }
  const registryBuiltAt = registry.builtAt;
  const key = keyFor(feedA, feedB);
  const cached = cache.get(key);
  if (cached && cached.registryBuiltAt === registryBuiltAt) return cached.result;

  const existing = inflight.get(key);
  if (existing) return existing;

  // Unique per-compute task id so overlapping computes (which happen for a
  // brief window during a registry rebuild) don't clobber each other's
  // spinner lifecycle.
  const taskId = `diff-${feedA}-vs-${feedB}-${registryBuiltAt}-${++taskSeq}`;
  const { beginMapTask, setMapTaskLabel, endMapTask, feeds } = useAppStore.getState();
  const aLabel = feeds[feedA]?.label ?? feedA;
  const bLabel = feeds[feedB]?.label ?? feedB;
  beginMapTask(taskId, `Diffing ${aLabel} ↔ ${bLabel}: reading stops (A)…`);

  // A self-reference so the work task can tell whether it still "owns" the
  // inflight slot and the map-task label — a second compute against a newer
  // registry can share the same (key, taskId) and we must not stomp it when
  // the older promise settles.
  let workRef!: Promise<DiffResult>;
  const work = (async () => {
    const t0 = performance.now();
    try {
      // NOTE: these are serialized on purpose. DuckDB-WASM's worker seems to
      // serialize queries internally, and on top of that `ensureFeedTablesLoaded`
      // can trigger parquet hydration. Running four of these concurrently was
      // causing the diff to hang for minutes on small feeds. Doing them one at
      // a time keeps behaviour predictable and mirrors the registry build path.
      const rawStopsA = await fetchRawStops(feedA);
      setMapTaskLabel(taskId, `Diffing ${aLabel} ↔ ${bLabel}: reading stops (B)…`);
      const rawStopsB = await fetchRawStops(feedB);
      setMapTaskLabel(taskId, `Diffing ${aLabel} ↔ ${bLabel}: reading routes (A)…`);
      const rawRoutesA = await fetchRawRoutes(feedA);
      setMapTaskLabel(taskId, `Diffing ${aLabel} ↔ ${bLabel}: reading routes (B)…`);
      const rawRoutesB = await fetchRawRoutes(feedB);
      setMapTaskLabel(taskId, `Diffing ${aLabel} ↔ ${bLabel}: matching…`);

      const result = diffFeeds(
        feedA,
        feedB,
        registry,
        rawStopsA,
        rawStopsB,
        rawRoutesA,
        rawRoutesB,
      );
      // Guard against registry rebuilds that happened while we were
      // computing. If the current snapshot moved on, we'd otherwise write
      // a stale entry that `peekDiff` will never hand out (builtAt mismatch)
      // and the hook would sit in `loading` until the next rekick.
      const current = getRegistry();
      if (!current || current.builtAt !== registryBuiltAt) {
        const dt = Math.round(performance.now() - t0);
        console.info(
          `[diff] ${aLabel} ↔ ${bLabel} discarded after ${dt}ms — registry changed mid-compute`,
        );
        return result;
      }
      const indexes = buildIndexes(result);
      cache.set(key, {
        key,
        registryBuiltAt,
        result,
        stopIndex: { a: indexes.a, b: indexes.b },
        routeIndex: indexes._routes,
      });
      emit();
      const dt = Math.round(performance.now() - t0);
      console.info(
        `[diff] ${aLabel} ↔ ${bLabel} ready in ${dt}ms`,
        `stops A=${rawStopsA.length} B=${rawStopsB.length}`,
        `routes A=${rawRoutesA.length} B=${rawRoutesB.length}`,
        result.summary,
      );
      return result;
    } catch (err) {
      console.error('[diff] compute failed', { feedA, feedB, err });
      throw err;
    } finally {
      // Only clear the inflight slot / map task if *we* are still the one
      // occupying them. `invalidateAll` may have cleared the slot, and a
      // newer compute may have taken over since then.
      if (inflight.get(key) === workRef) inflight.delete(key);
      endMapTask(taskId);
    }
  })();
  workRef = work;
  inflight.set(key, work);
  return work;
}

/** Synchronously returns the cached diff, or null. Does not trigger work. */
export function peekDiff(feedA: string, feedB: string): DiffResult | null {
  const registry = getRegistry();
  if (!registry) return null;
  const entry = cache.get(keyFor(feedA, feedB));
  if (!entry) return null;
  if (entry.registryBuiltAt !== registry.builtAt) return null;
  return entry.result;
}

/** O(1) lookup: does the *active* feed's raw stop belong to a diff entry? */
export function lookupStopDiff(
  feedA: string,
  feedB: string,
  feedSide: 'a' | 'b',
  rawStopId: string,
): StopDiffEntry | null {
  const entry = cache.get(keyFor(feedA, feedB));
  if (!entry) return null;
  const registry = getRegistry();
  if (!registry || entry.registryBuiltAt !== registry.builtAt) return null;
  return entry.stopIndex[feedSide].get(rawStopId) ?? null;
}

export function lookupRouteDiff(
  feedA: string,
  feedB: string,
  feedSide: 'a' | 'b',
  rawRouteId: string,
): RouteDiffEntry | null {
  const entry = cache.get(keyFor(feedA, feedB));
  if (!entry) return null;
  const registry = getRegistry();
  if (!registry || entry.registryBuiltAt !== registry.builtAt) return null;
  return entry.routeIndex[feedSide].get(rawRouteId) ?? null;
}

/** For debug / dev-tools. */
export function _debugSnapshot(): { keys: string[] } {
  return { keys: [...cache.keys()] };
}

/** Re-export for callers convenience. */
export type { RegistrySnapshot };
