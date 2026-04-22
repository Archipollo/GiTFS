// Diff-mode controls for the left panel.
//
// Shows the current (A → B) pair, the status of the diff computation, and a
// set of category toggles (added / removed / moved / renamed / unchanged)
// that filter both the map overlay and the drawer lists.

import { useAppStore, type FeedMeta } from '../state/app-store';
import { useDiff } from './useDiff';
import { DIFF_COLOR } from './geojson';
import type { StopStatus } from './engine';
import { useRegistry } from '../registry/useRegistry';
import { isRegistryStale } from '../registry/registry';
import { stripYearSuffix, yearOfFeed } from '../timeline/math';

function yearedOptionLabel(f: FeedMeta): string {
  const fy = yearOfFeed(f);
  const suffix = fy.synthetic ? '?' : '';
  return `${fy.year}${suffix} · ${stripYearSuffix(f.label)}`;
}

const STOP_STATUS_LABELS: Array<{ id: StopStatus; label: string }> = [
  { id: 'added', label: 'Added' },
  { id: 'removed', label: 'Removed' },
  { id: 'moved', label: 'Moved' },
  { id: 'renamed', label: 'Renamed' },
  { id: 'unchanged', label: 'Unchanged' },
];

export default function DiffSidebar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const setCompareFeed = useAppStore((s) => s.setCompareFeed);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);

  const registry = useRegistry();
  const diff = useDiff(activeFeedId, compareFeedId);

  const activeFeed = activeFeedId ? feeds[activeFeedId] : null;
  const a = activeFeed ? yearedOptionLabel(activeFeed) : activeFeedId;
  const staleRegistry = registry && isRegistryStale(feedOrder);

  return (
    <div className="diff-sidebar">
      <h3>Diff</h3>
      <div className="diff-pair">
        <div className="diff-pair-row">
          <span className="diff-pair-badge diff-pair-badge--a">A</span>
          <span className="diff-pair-name" title={a ?? ''}>
            {a ?? <span className="muted">pick an active feed</span>}
          </span>
        </div>
        <div className="diff-pair-arrow">↓</div>
        <div className="diff-pair-row">
          <span className="diff-pair-badge diff-pair-badge--b">B</span>
          <select
            value={compareFeedId ?? ''}
            onChange={(e) => setCompareFeed(e.target.value || null)}
            className="diff-pair-select"
          >
            <option value="">(pick a compare feed)</option>
            {feedOrder
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

      {diff.kind === 'idle' && (
        <p className="muted">Pick a B feed above to compute the diff.</p>
      )}
      {diff.kind === 'no-registry' && (
        <p className="muted">
          Build the Entity Registry first (bottom drawer → Registry) so the
          diff can match stops and routes across feeds.
        </p>
      )}
      {staleRegistry && (
        <p className="stale-badge" style={{ display: 'inline-block' }}>
          registry stale
        </p>
      )}
      {diff.kind === 'loading' && (
        <p className="muted">
          <span className="spinner" style={{ width: 12, height: 12, display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
          Computing diff…
        </p>
      )}
      {diff.kind === 'error' && (
        <p className="muted" style={{ color: 'var(--removed)' }}>
          Diff failed: {diff.message}
        </p>
      )}

      {diff.kind === 'ready' && (
        <>
          <h3>Changes</h3>
          <div className="diff-counts">
            {STOP_STATUS_LABELS.map(({ id, label }) => {
              const n = diff.result.summary.stops[id];
              const on = diffStopVisibility[id];
              return (
                <label key={id} className={`diff-count ${on ? 'on' : 'off'}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleDiffStopVisibility(id)}
                  />
                  <span className="diff-count-swatch" style={{ background: DIFF_COLOR[id] }} />
                  <span className="diff-count-label">{label}</span>
                  <span className="diff-count-n">{n}</span>
                </label>
              );
            })}
          </div>

          <h3>Routes</h3>
          <table className="diff-route-table">
            <tbody>
              <tr>
                <td className="muted">Added</td>
                <td>{diff.result.summary.routes.added}</td>
              </tr>
              <tr>
                <td className="muted">Removed</td>
                <td>{diff.result.summary.routes.removed}</td>
              </tr>
              <tr>
                <td className="muted">Renumbered</td>
                <td>{diff.result.summary.routes.renumbered}</td>
              </tr>
              <tr>
                <td className="muted">Modified</td>
                <td>{diff.result.summary.routes.modified}</td>
              </tr>
              <tr>
                <td className="muted">Unchanged</td>
                <td>{diff.result.summary.routes.unchanged}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
