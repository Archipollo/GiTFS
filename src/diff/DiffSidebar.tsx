// Diff-mode controls for the left panel.
//
// Shows the current (A → B) pair, the status of the diff computation, and a
// set of category toggles (added / removed / moved / renamed / unchanged)
// that filter both the map overlay and the drawer lists.

import { useAppStore, type FeedMeta } from '../state/app-store';
import { useDiff } from './useDiff';
import { DIFF_COLOR } from './geojson';
import { SEGMENT_COLOR, type GeomStatus } from '../gtfs/segment-graph';
import type { StopStatus, RouteStatus } from './engine';
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

const ROUTE_STATUS_LABELS: Array<{ id: RouteStatus; label: string }> = [
  { id: 'added', label: 'Added' },
  { id: 'removed', label: 'Removed' },
  { id: 'renumbered', label: 'Renumbered' },
  { id: 'modified', label: 'Modified' },
  { id: 'unchanged', label: 'Unchanged' },
];

const SEGMENT_STATUS_LABELS: Array<{ id: GeomStatus; label: string; hint: string }> = [
  { id: 'added', label: 'New geometry', hint: 'Track present only in the B feed' },
  { id: 'removed', label: 'Removed geometry', hint: 'Track present only in the A feed' },
  { id: 'unchanged', label: 'Shared geometry', hint: 'Track present in both feeds' },
];

function formatLengthKm(meters: number): string {
  if (meters < 1) return '0 km';
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export default function DiffSidebar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const setCompareFeed = useAppStore((s) => s.setCompareFeed);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const toggleDiffSegmentVisibility = useAppStore((s) => s.toggleDiffSegmentVisibility);
  const diffSegmentSummary = useAppStore((s) => s.diffSegmentSummary);

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
          <h3>Stops</h3>
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

          <h3>Line geometry</h3>
          <p
            className="muted"
            style={{ margin: '0 0 6px', fontSize: 11, lineHeight: 1.35 }}
          >
            Lines are compared at the segment level — shared trackage reads
            as unchanged, only the truly different bits are highlighted.
          </p>
          <div className="diff-counts">
            {SEGMENT_STATUS_LABELS.map(({ id, label, hint }) => {
              const on = diffSegmentVisibility[id];
              const meters = segmentLengthFor(diffSegmentSummary, diff.result.feedA, diff.result.feedB, id);
              return (
                <label
                  key={id}
                  className={`diff-count ${on ? 'on' : 'off'}`}
                  title={hint}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleDiffSegmentVisibility(id)}
                  />
                  <span
                    className="diff-count-swatch"
                    style={{ background: SEGMENT_COLOR[id] }}
                  />
                  <span className="diff-count-label">{label}</span>
                  <span className="diff-count-n">
                    {meters == null ? '…' : formatLengthKm(meters)}
                  </span>
                </label>
              );
            })}
          </div>

          <h3 style={{ marginTop: 14 }}>Line entities</h3>
          <p
            className="muted"
            style={{ margin: '0 0 6px', fontSize: 11, lineHeight: 1.35 }}
          >
            Route-level classification from the Entity Registry. Shown for
            reference; map coloring follows the geometry diff above.
          </p>
          <div className="diff-counts">
            {ROUTE_STATUS_LABELS.map(({ id, label }) => {
              const n = diff.result.summary.routes[id];
              return (
                <div key={id} className="diff-count on" style={{ cursor: 'default' }}>
                  <span style={{ width: 14 }} />
                  <span className="diff-count-label">{label}</span>
                  <span className="diff-count-n">{n}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function segmentLengthFor(
  summary:
    | { feedA: string; feedB: string; lengths: Record<GeomStatus, number> }
    | null,
  feedA: string,
  feedB: string,
  status: GeomStatus,
): number | null {
  if (!summary) return null;
  if (summary.feedA !== feedA || summary.feedB !== feedB) return null;
  return summary.lengths[status];
}
