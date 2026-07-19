// Shared trigger for the off-main-thread route-scoped geometry diff.
//
// Extracted from MapView's old diff-mode Effect A so every consumer of the
// new line-list / split-view / detail UI (LineListSidebar, SplitMapView,
// RouteDetailView) computes the diff exactly once per (feedA, feedB,
// registryBuiltAt) — `getShapeIndex`/`getDiffedShapes` are already memoized
// in segment-graph.ts, so mounting several components against the same
// `DiffStatus` never triggers duplicate worker work.

import { useEffect, useState } from 'react';
import { buildRoutePairs, getDiffedShapes, getShapeIndex, type DiffedShapes } from '../gtfs/segment-graph';
import { useAppStore } from '../state/app-store';
import type { DiffStatus } from './useDiff';

/**
 * Runs the route-scoped geometry diff for the current diff pair and caches
 * the result locally (in addition to segment-graph's own cache) so this
 * hook's consumers only re-render when the diff actually changes, not on
 * every visibility/filter toggle. Also updates the shared
 * `diffRoutesWithGeomChange` store field — kept as a store field (not a
 * hook return value) because `DiffInspector` already reads it independently
 * of whichever view is currently mounted.
 */
export function useDiffedShapes(diffStatus: DiffStatus): DiffedShapes | null {
  const [diffedShapes, setDiffedShapes] = useState<DiffedShapes | null>(null);

  useEffect(() => {
    if (diffStatus.kind !== 'ready') {
      setDiffedShapes(null);
      return;
    }
    let cancelled = false;
    const feedA = diffStatus.feedA;
    const feedB = diffStatus.feedB;
    const pairs = buildRoutePairs(diffStatus.result);
    const registryBuiltAt = diffStatus.result.builtAt;
    (async () => {
      try {
        const [idxA, idxB] = await Promise.all([
          getShapeIndex(feedA),
          getShapeIndex(feedB),
        ]);
        if (cancelled) return;
        const diffed = await getDiffedShapes(idxA, idxB, pairs, registryBuiltAt);
        if (cancelled) return;
        setDiffedShapes(diffed);
        const changed = new Set<string>();
        for (const run of diffed.runs) {
          if (run.status !== 'unchanged' && run.canonicalId) changed.add(run.canonicalId);
        }
        useAppStore.getState().setDiffRoutesWithGeomChange(changed);
      } catch (err) {
        if (!cancelled) console.warn('diff-segments compute failed', err);
      }
    })();
    return () => {
      cancelled = true;
      useAppStore.getState().setDiffRoutesWithGeomChange(null);
    };
  }, [diffStatus]);

  return diffedShapes;
}
