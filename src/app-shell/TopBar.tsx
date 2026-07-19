import { useAppStore, type FeedMeta } from '../state/app-store';
import { useRegistry, useRegistryStale } from '../registry/useRegistry';
import { useBuildRegistry } from '../registry/useBuildRegistry';
import { stripYearSuffix, yearOfFeed } from '../timeline/math';
import UploadMenu from './UploadMenu';
import FeedBar from './FeedBar';

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

  const registry = useRegistry();
  const stale = useRegistryStale();
  const { handleBuild, building } = useBuildRegistry();

  const sortedFeedOrder = [...feedOrder].sort(
    (a, b) => yearOfFeed(feeds[a]).year - yearOfFeed(feeds[b]).year,
  );

  return (
    <header className="topbar">
      <span className="brand">GiTFS</span>
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
      </div>
      <div className="topbar-right">
        <FeedBar />
        <UploadMenu />
      </div>
    </header>
  );
}
