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
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const setCompareFeed = useAppStore((s) => s.setCompareFeed);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const setDiffOverviewLayout = useAppStore((s) => s.setDiffOverviewLayout);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const setFeedASelection = useAppStore((s) => s.setFeedASelection);

  // Slot A is the persistent Feed A selection, shared by every layout: in
  // single/split it's the older side of the A/B diff, in timeline it's the
  // baseline (left edge). Slot B is always the fixed right edge (in timeline,
  // TimelineStrip bounds its range to A..B and scrubs within it — B doesn't
  // move just because the slider does).
  const isTimeline = diffOverviewLayout === 'timeline';
  const slotAValue = feedASelection;
  const slotBValue = compareFeedId;
  const setSlotA = (id: string | null) => setFeedASelection(id);
  const setSlotB = (id: string | null) => setCompareFeed(id);

  const registry = useRegistry();
  const stale = useRegistryStale();
  const { handleBuild, building, registryProgress } = useBuildRegistry();
  const diff = useDiff(slotAValue, slotBValue, isTimeline);

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
              value={slotAValue ?? ''}
              onChange={(e) => setSlotA(e.target.value || null)}
              className="diff-pair-select"
            >
              <option value="">{isTimeline ? '(pick baseline year)' : '(pick older feed)'}</option>
              {sortedFeedOrder
                .filter((id) => isTimeline || id !== slotBValue || id === slotAValue)
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
              value={slotBValue ?? ''}
              onChange={(e) => setSlotB(e.target.value || null)}
              className="diff-pair-select"
            >
              <option value="">{isTimeline ? '(pick end year)' : '(pick newer feed)'}</option>
              {sortedFeedOrder
                .filter((id) => isTimeline || id !== slotAValue || id === slotBValue)
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
          disabled={building || feedOrder.length < 2 || !slotAValue || !slotBValue}
          onClick={handleBuild}
          title={
            feedOrder.length < 2
              ? 'Load at least two feeds first'
              : !slotAValue || !slotBValue
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
