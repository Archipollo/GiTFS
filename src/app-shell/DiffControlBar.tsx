// Slim TopBar row (diff mode only): registry/diff status and the layout
// switch (Network / Split / Timeline) plus the GTFS-Diff export button. The
// A/B feed pickers and Make/Remake diff button live in TopBar itself so
// they sit in the same centered row as the mode tabs.

import { useAppStore } from '../state/app-store';
import { useDiff } from '../diff/useDiff';
import { useRegistryStale } from '../registry/useRegistry';
import { useBuildRegistry } from '../registry/useBuildRegistry';
import { exportGtfsDiffV1 } from '../diff/gtfs-diff-export';

export default function DiffControlBar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const setDiffOverviewLayout = useAppStore((s) => s.setDiffOverviewLayout);

  const stale = useRegistryStale();
  const diff = useDiff(activeFeedId, compareFeedId);
  const { building, registryProgress } = useBuildRegistry();

  const handleExportDiff = () => {
    if (diff.kind !== 'ready') return;
    const csv = exportGtfsDiffV1(diff.result);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gtfs-diff-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="diff-control-bar">
      {building && registryProgress && (
        <span className="muted" style={{ fontSize: 11 }}>
          {registryProgress.stage}
          {registryProgress.feedLabel ? ` · ${registryProgress.feedLabel}` : ''}
        </span>
      )}
      {!building && stale && (
        <span
          className="stale-badge"
          title="Loaded feeds don't match the feeds the registry was built from."
        >
          stale
        </span>
      )}

      {diff.kind === 'idle' && <span className="muted">Pick a B feed above to compute the diff.</span>}
      {diff.kind === 'no-registry' && (
        <span className="muted">Build the Entity Registry above so the diff can match stops and routes.</span>
      )}
      {diff.kind === 'loading' && (
        <span className="muted">
          <span className="spinner" style={{ width: 12, height: 12, display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
          Computing diff…
        </span>
      )}
      {diff.kind === 'error' && (
        <span className="muted" style={{ color: 'var(--removed)' }}>Diff failed: {diff.message}</span>
      )}

      <div className="route-detail-mode-switch" style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          className={diffOverviewLayout === 'single' ? 'on' : ''}
          onClick={() => setDiffOverviewLayout('single')}
        >
          Network
        </button>
        <button
          type="button"
          className={diffOverviewLayout === 'split' ? 'on' : ''}
          onClick={() => setDiffOverviewLayout('split')}
        >
          Split view
        </button>
        <button
          type="button"
          className={diffOverviewLayout === 'timeline' ? 'on' : ''}
          onClick={() => setDiffOverviewLayout('timeline')}
        >
          Timeline
        </button>
      </div>

      {diff.kind === 'ready' && (
        <button
          onClick={handleExportDiff}
          style={{ fontSize: 12 }}
          title="Export the current diff as a GTFS-Diff (MobilityData specification)"
        >
          Export GTFS-Diff
        </button>
      )}
    </div>
  );
}
