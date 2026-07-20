// Diff-mode map area container: owns the shared `useDiffedShapes` call (so
// the worker computation runs once no matter which child view is mounted)
// and switches between the synced split overview and the per-route detail
// view based on `diffViewMode`.

import { useEffect } from 'react';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import { useDiffedShapes } from './useDiffedShapes';
import { segmentDiffToGeoJSON, buildRunLineStatus } from '../gtfs/segment-graph';
import { SplitMapView } from './SplitMapView';
import { NetworkDiffMapView } from './NetworkDiffMapView';
import { RouteDetailView } from './RouteDetailView';
import MapView from '../map/MapView';

export function DiffMapArea() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const setDiffSegmentSummary = useAppStore((s) => s.setDiffSegmentSummary);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);

  const diffStatus = useDiff(activeFeedId, compareFeedId);
  const diffedShapes = useDiffedShapes(diffStatus);

  // Own the one-time summary write (sidebar swatches) so neither map pane
  // duplicates it.
  useEffect(() => {
    if (!diffedShapes) {
      setDiffSegmentSummary(null);
      return;
    }
    const lineStatus = diffStatus.kind === 'ready' ? buildRunLineStatus(diffStatus.result.routes) : undefined;
    const { lengths, routeLengths } = segmentDiffToGeoJSON(
      diffedShapes,
      diffSegmentVisibility,
      undefined,
      lineStatus,
    );
    setDiffSegmentSummary({
      feedA: diffedShapes.feedA,
      feedB: diffedShapes.feedB,
      lengths,
      routeLengths,
    });
  }, [diffedShapes, diffSegmentVisibility, diffStatus, setDiffSegmentSummary]);

  // Timeline is a single-feed exploration layout — it doesn't need a computed
  // A/B diff, so it bypasses the "diff not ready" gate below.
  if (diffOverviewLayout === 'timeline') return <MapView />;

  if (diffStatus.kind !== 'ready') {
    return (
      <div className="diff-map-area-empty">
        <p className="muted">
          {diffStatus.kind === 'idle' && 'Pick feed A and feed B above to compare them.'}
          {diffStatus.kind === 'no-registry' && 'Build the entity registry first.'}
          {diffStatus.kind === 'loading' && 'Computing diff…'}
          {diffStatus.kind === 'error' && `Diff failed: ${diffStatus.message}`}
        </p>
      </div>
    );
  }

  if (diffViewMode === 'detail') return <RouteDetailView diffedShapes={diffedShapes} />;
  return diffOverviewLayout === 'split'
    ? <SplitMapView diffedShapes={diffedShapes} />
    : <NetworkDiffMapView diffedShapes={diffedShapes} />;
}
