import { useAppStore, type FeedMeta } from '../state/app-store';
import { useRegistry, useRegistryStale } from '../registry/useRegistry';
import { useBuildRegistry } from '../registry/useBuildRegistry';
import { useDiff } from '../diff/useDiff';
import { exportGtfsDiffV1 } from '../diff/gtfs-diff-export';
import { stripYearSuffix, yearOfFeed } from '../timeline/math';
import UploadMenu from './UploadMenu';
import FeedBar from './FeedBar';
import { AnalysisMenu } from './AnalysisMenu';

function yearedOptionLabel(f: FeedMeta): string {
  const fy = yearOfFeed(f);
  const suffix = fy.synthetic ? '?' : '';
  return `${fy.year}${suffix} · ${stripYearSuffix(f.label)}`;
}

export default function TopBar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const setActiveFeed = useAppStore((s) => s.setActiveFeed);
  const setCompareFeed = useAppStore((s) => s.setCompareFeed);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const setDiffOverviewLayout = useAppStore((s) => s.setDiffOverviewLayout);

  const registry = useRegistry();
  const stale = useRegistryStale();
  const { handleBuild, building, registryProgress } = useBuildRegistry();
  const diff = useDiff(activeFeedId, compareFeedId);

  const sortedFeedOrder = [...feedOrder].sort(
    (a, b) => yearOfFeed(feeds[a]).year - yearOfFeed(feeds[b]).year,
  );

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
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">GiTFS</span>
        <FeedBar />
        <UploadMenu />
      </div>
      <div className="topbar-center">
        <div className="diff-pair diff-pair--inline">
          <div className="diff-pair-row">
            <span className="diff-pair-badge diff-pair-badge--a">A</span>
            <select
              value={activeFeedId ?? ''}
              onChange={(e) => setActiveFeed(e.target.value || null)}
              className="diff-pair-select"
            >
              <option value="">(pick older feed)</option>
              {sortedFeedOrder
                .filter((id) => id !== compareFeedId)
                .map((id) => {
                  const f = feeds[id];
                  return (
                    <option key={id} value={id}>
                      {f ? yearedOptionLabel(f) : id}
                    </option>
                  );
                })}
            </select>
          </div>
          <div className="diff-pair-arrow">→</div>
          <div className="diff-pair-row">
            <span className="diff-pair-badge diff-pair-badge--b">B</span>
            <select
              value={compareFeedId ?? ''}
              onChange={(e) => setCompareFeed(e.target.value || null)}
              className="diff-pair-select"
            >
              <option value="">(pick newer feed)</option>
              {sortedFeedOrder
                .filter((id) => id !== activeFeedId)
                .map((id) => {
                  const f = feeds[id];
                  return (
                    <option key={id} value={id}>
                      {f ? yearedOptionLabel(f) : id}
                    </option>
                  );
                })}
            </select>
          </div>
        </div>

        <button
          disabled={building || feedOrder.length < 2 || !activeFeedId || !compareFeedId}
          onClick={handleBuild}
          title={
            feedOrder.length < 2
              ? 'Load at least two feeds first'
              : !activeFeedId || !compareFeedId
                ? 'Select both A and B feeds above'
                : 'Build entity registry and compute diff'
          }
          style={{ padding: '3px 10px', fontSize: 12 }}
        >
          {building ? 'Computing…' : registry && !stale ? 'Remake diff' : 'Make diff'}
        </button>

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
        {diff.kind === 'loading' && (
          <span className="muted">
            <span
              className="spinner"
              style={{ width: 12, height: 12, display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }}
            />
            Computing diff…
          </span>
        )}
        {diff.kind === 'error' && (
          <span className="muted" style={{ color: 'var(--removed)' }}>
            Diff failed: {diff.message}
          </span>
        )}
      </div>
      <div className="topbar-right">
        <AnalysisMenu />
        <div className="route-detail-mode-switch">
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
            className="topbar-export-btn"
            onClick={handleExportDiff}
            title="Export the current diff as a GTFS-Diff (MobilityData specification)"
          >
            Export GTFS-Diff
          </button>
        )}
      </div>
    </header>
  );
}
