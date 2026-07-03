// Diff-mode controls for the left panel.
//
// Shows the current (A → B) pair, registry build controls, the status of the
// diff computation, category toggles, and a GTFS-Diff v1 export button.

import { useAppStore, type FeedMeta } from '../state/app-store';
import { useDiff } from './useDiff';
import { DIFF_COLOR } from './geojson';
import { SEGMENT_COLOR, type GeomStatus } from '../gtfs/segment-graph';
import {
  FREQUENCY_GAIN_COLOR,
  FREQUENCY_LOSS_COLOR,
  FREQUENCY_NEUTRAL_COLOR,
} from './frequency';
import type { StopStatus } from './engine';
import { useRegistry, useRegistryStale } from '../registry/useRegistry';
import { useBuildRegistry } from '../registry/useBuildRegistry';
import { stripYearSuffix, yearOfFeed } from '../timeline/math';
import { exportGtfsDiffV1 } from './gtfs-diff-export';

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

function segmentLengthFor(
  summary: { feedA: string; feedB: string; lengths: Record<GeomStatus, number> } | null,
  feedA: string,
  feedB: string,
  status: GeomStatus,
): number | null {
  if (!summary) return null;
  if (summary.feedA !== feedA || summary.feedB !== feedB) return null;
  return summary.lengths[status];
}

function frequencySummaryFor(
  summary:
    | {
        feedA: string;
        feedB: string;
        maxAbsDelta: number;
        scaleAbsDelta: number;
        routeCount: number;
      }
    | null,
  feedA: string,
  feedB: string,
): { maxAbsDelta: number; scaleAbsDelta: number; routeCount: number } | null {
  if (!summary) return null;
  if (summary.feedA !== feedA || summary.feedB !== feedB) return null;
  return summary;
}

function formatTrips(n: number): string {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded).toLocaleString();
  if (rounded > 0) return `+${abs}`;
  if (rounded < 0) return `−${abs}`;
  return '0';
}

export function DiffSidebar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const setActiveFeed = useAppStore((s) => s.setActiveFeed);
  const setCompareFeed = useAppStore((s) => s.setCompareFeed);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const toggleDiffSegmentVisibility = useAppStore((s) => s.toggleDiffSegmentVisibility);
  const diffSegmentSummary = useAppStore((s) => s.diffSegmentSummary);
  const diffOverlay = useAppStore((s) => s.diffOverlay);
  const setDiffOverlay = useAppStore((s) => s.setDiffOverlay);
  const diffFrequencySummary = useAppStore((s) => s.diffFrequencySummary);

  const registry = useRegistry();
  const stale = useRegistryStale();
  const diff = useDiff(activeFeedId, compareFeedId);
  const { handleBuild, building, registryProgress } = useBuildRegistry();

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
    <div className="diff-sidebar">
      <h3>Diff</h3>
      <div className="diff-pair">
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
        <div className="diff-pair-arrow">↓</div>
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
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
        {!building && !registry && feedOrder.length > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>not built yet</span>
        )}
      </div>

      {diff.kind === 'idle' && (
        <p className="muted">Pick a B feed above to compute the diff.</p>
      )}
      {diff.kind === 'no-registry' && (
        <p className="muted">
          Build the Entity Registry above so the diff can match stops and routes across feeds.
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
          {diffOverlay === 'frequency' && (
            <p className="muted" style={{ marginTop: 0, fontSize: 11 }}>
              Dimmed while viewing frequency, to keep the two colour scales from competing.
            </p>
          )}
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

          <h3>Lines</h3>
          <div className="diff-overlay-toggle" style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            <button
              onClick={() => setDiffOverlay('geometry')}
              aria-pressed={diffOverlay === 'geometry'}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '4px 6px',
                fontWeight: diffOverlay === 'geometry' ? 600 : 400,
                background: diffOverlay === 'geometry' ? 'var(--accent-bg, #e2e8f0)' : undefined,
              }}
              title="Show which track geometry was added, removed, or kept"
            >
              Geometry
            </button>
            <button
              onClick={() => setDiffOverlay('frequency')}
              aria-pressed={diffOverlay === 'frequency'}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '4px 6px',
                fontWeight: diffOverlay === 'frequency' ? 600 : 400,
                background: diffOverlay === 'frequency' ? 'var(--accent-bg, #e2e8f0)' : undefined,
              }}
              title="Show how weekly trip frequency changed per line"
            >
              Frequency
            </button>
          </div>

          {diffOverlay === 'geometry' && (
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
          )}

          {diffOverlay === 'frequency' && (() => {
            const freq = frequencySummaryFor(diffFrequencySummary, diff.result.feedA, diff.result.feedB);
            const scaleMax = freq ? Math.max(1, Math.round(freq.scaleAbsDelta)) : null;
            // Colour/width max out at the p95 cap; when some route's change
            // exceeds it, the end labels become open-ended ("≥ …").
            const capped = freq != null && Math.round(freq.maxAbsDelta) > Math.round(freq.scaleAbsDelta);
            return (
              <div className="diff-frequency-legend" style={{ fontSize: 12 }}>
                <p className="muted" style={{ marginTop: 0 }}>
                  Change in scheduled trips per week on each line, from A to B.
                  Colour shows the direction, line width the size of the change.
                </p>
                <div
                  style={{
                    height: 10,
                    borderRadius: 4,
                    background: `linear-gradient(to right, ${FREQUENCY_LOSS_COLOR}, ${FREQUENCY_NEUTRAL_COLOR}, ${FREQUENCY_GAIN_COLOR})`,
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>{scaleMax == null ? '…' : `${capped ? '≤ ' : ''}${formatTrips(-scaleMax)}`}</span>
                  <span>0</span>
                  <span>{scaleMax == null ? '…' : `${capped ? '≥ ' : ''}${formatTrips(scaleMax)}`}</span>
                </div>
                <div className="muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>fewer trips/week</span>
                  <span>more trips/week</span>
                </div>
                <p className="muted" style={{ marginTop: 8 }}>
                  {freq
                    ? `${freq.routeCount} lines compared` +
                      (capped
                        ? ` · scale capped at the 95th percentile; biggest single change: ${Math.round(freq.maxAbsDelta).toLocaleString()} trips/week`
                        : '')
                    : 'Computing frequency diff…'}
                </p>
              </div>
            );
          })()}

          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <button
              onClick={handleExportDiff}
              style={{ width: '100%', fontSize: 12 }}
              title="Export the current diff as a GTFS-Diff (MobilityData specification)"
            >
              Export GTFS-Diff
            </button>
          </div>
        </>
      )}
    </div>
  );
}
