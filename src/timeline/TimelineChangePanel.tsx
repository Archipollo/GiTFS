// "What changed since baseline?" narrative panel for the Timeline layout —
// the primary artifact for a thesis case study: a real diff narrative
// (backed by the same engine as A/B diff mode) plus every export the user
// needs (map PNG, GTFS-Diff CSV, per-year stats CSV, trend chart SVG).

import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useBaselineDiff } from './useBaselineDiff';
import { feedYearsOf, feedYearLabels } from './math';
import { InspectorSection } from '../inspector/components';
import { exportGtfsDiffV1 } from '../diff/gtfs-diff-export';
import {
  buildTimelineTrendRows,
  downloadTimelineTrendCsv,
  fetchWeeklyTripsForFeedYears,
  type TimelineYearRow,
} from './timelineExport';
import { TimelineTrendChart } from './TimelineTrendChart';

function downloadDiffCsv(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gitfs-timeline-diff-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TimelineChangePanel() {
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const requestMapSnapshot = useAppStore((s) => s.requestMapSnapshot);

  const status = useBaselineDiff();

  const feedYears = feedYearsOf(feedOrder, feeds);
  const labels = feedYearLabels(feedYears);
  const baselineIdx = feedYears.findIndex((y) => y.feedId === feedASelection);
  const baselineLabel = baselineIdx >= 0 ? labels[baselineIdx] : null;

  const compareFromLabel = status.kind === 'ready'
    ? labels[feedYears.findIndex((y) => y.feedId === status.diffResult.feedA)] ?? null
    : null;
  const headerLabel = status.kind === 'ready' && !status.cumulative
    ? (compareFromLabel ?? 'previous year')
    : (baselineLabel ?? 'baseline');

  const [trendRows, setTrendRows] = useState<TimelineYearRow[]>(() =>
    buildTimelineTrendRows(feedYears, labels, feeds, null),
  );

  useEffect(() => {
    let cancelled = false;
    setTrendRows(buildTimelineTrendRows(feedYears, labels, feeds, null));
    fetchWeeklyTripsForFeedYears(feedYears)
      .then((weekly) => {
        if (!cancelled) setTrendRows(buildTimelineTrendRows(feedYears, labels, feeds, weekly));
      })
      .catch((err) => console.warn('[timeline] weekly-trips trend fetch failed', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedOrder.join(','), feeds, feedASelection]);

  return (
    <div className="timeline-change-panel">
      <h3>Since {headerLabel}</h3>

      {status.kind === 'idle' && <p className="muted">Pick a baseline to compare against.</p>}
      {status.kind === 'no-registry' && (
        <p className="muted">Build the Entity Registry first so changes can be compared across feeds.</p>
      )}
      {status.kind === 'loading' && <p className="muted">Computing diff…</p>}
      {status.kind === 'error' && (
        <p className="muted" style={{ color: 'var(--removed)' }}>Diff failed: {status.message}</p>
      )}

      {status.kind === 'ready' && (
        <>
          <ul className="timeline-narrative">
            {status.summary.narrative.map((line) => <li key={line}>{line}</li>)}
            {!status.reroutedPending && !!status.reroutedRouteCount && (
              <li>{status.reroutedRouteCount} lines rerouted (kept their identity, changed path) since baseline.</li>
            )}
          </ul>

          <InspectorSection title="Stops" count={status.summary.stopCounts.added + status.summary.stopCounts.removed + status.summary.stopCounts.moved + status.summary.stopCounts.renamed}>
            <table className="timeline-change-table">
              <tbody>
                <tr><td className="muted">Added</td><td>{status.summary.stopCounts.added}</td></tr>
                {status.cumulative && status.summary.netStopCounts.added !== status.summary.stopCounts.added && (
                  <tr>
                    <td className="muted" style={{ paddingLeft: '1em' }}>Net added</td>
                    <td title="Stops added and later removed again within this span net out and aren't counted here.">
                      {status.summary.netStopCounts.added}
                    </td>
                  </tr>
                )}
                <tr><td className="muted">Removed</td><td>{status.summary.stopCounts.removed}</td></tr>
                {status.cumulative && status.summary.netStopCounts.removed !== status.summary.stopCounts.removed && (
                  <tr>
                    <td className="muted" style={{ paddingLeft: '1em' }}>Net removed</td>
                    <td title="Stops removed and later re-added within this span net out and aren't counted here.">
                      {status.summary.netStopCounts.removed}
                    </td>
                  </tr>
                )}
                <tr><td className="muted">Moved</td><td>{status.summary.stopCounts.moved}</td></tr>
                <tr><td className="muted">Renamed</td><td>{status.summary.stopCounts.renamed}</td></tr>
                <tr><td className="muted">Unchanged</td><td>{status.summary.stopCounts.unchanged}</td></tr>
              </tbody>
            </table>
          </InspectorSection>

          <InspectorSection
            title="Routes"
            count={
              status.summary.routeCounts.added
              + status.summary.routeCounts.removed
              + status.summary.routeCounts.renumbered
              + status.summary.routeCounts.modified
              + (status.reroutedRouteCount ?? 0)
            }
          >
            <table className="timeline-change-table">
              <tbody>
                <tr><td className="muted">Added</td><td>{status.summary.routeCounts.added}</td></tr>
                <tr><td className="muted">Removed</td><td>{status.summary.routeCounts.removed}</td></tr>
                <tr><td className="muted">Renumbered</td><td>{status.summary.routeCounts.renumbered}</td></tr>
                <tr>
                  <td className="muted">Rerouted</td>
                  <td title="Lines whose identity is unchanged but whose physical path differs from baseline.">
                    {status.reroutedPending ? 'computing…' : status.reroutedRouteCount ?? 0}
                  </td>
                </tr>
                <tr><td className="muted">Modified</td><td>{status.summary.routeCounts.modified}</td></tr>
                <tr><td className="muted">Unchanged</td><td>{status.summary.routeCounts.unchanged}</td></tr>
              </tbody>
            </table>
          </InspectorSection>

          <InspectorSection title="Line length">
            <table className="timeline-change-table">
              <tbody>
                <tr>
                  <td className="muted">Added</td>
                  <td>{status.routeKmPending ? 'computing…' : `${status.routeKm ? status.routeKm.addedKm.toFixed(1) : '0.0'} km`}</td>
                </tr>
                <tr>
                  <td className="muted">Removed</td>
                  <td>{status.routeKmPending ? 'computing…' : `${status.routeKm ? status.routeKm.removedKm.toFixed(1) : '0.0'} km`}</td>
                </tr>
              </tbody>
            </table>
          </InspectorSection>

          <InspectorSection title="Service">
            <table className="timeline-change-table">
              <tbody>
                <tr>
                  <td className="muted">Trip count</td>
                  <td>
                    {status.summary.tripCountDelta != null
                      ? `${status.summary.tripCountDelta >= 0 ? '+' : ''}${status.summary.tripCountDelta}`
                      : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Frequency</td>
                  <td>
                    {status.summary.frequencyPending
                      ? 'computing…'
                      : `${status.summary.frequencyGainRouteCount} gained · ${status.summary.frequencyLossRouteCount} lost`}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Service window (baseline)</td>
                  <td>{status.summary.serviceSpanBaseline.start ?? '—'} → {status.summary.serviceSpanBaseline.end ?? '—'}</td>
                </tr>
                <tr>
                  <td className="muted">Service window (current)</td>
                  <td>{status.summary.serviceSpanCurrent.start ?? '—'} → {status.summary.serviceSpanCurrent.end ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          </InspectorSection>
        </>
      )}

      <InspectorSection title="Trend across loaded years" defaultCollapsed>
        <TimelineTrendChart rows={trendRows} baselineIndex={baselineIdx >= 0 ? baselineIdx : null} />
      </InspectorSection>

      <div className="timeline-export-actions">
        <button type="button" onClick={requestMapSnapshot} title="Export the current map frame as PNG">
          Export map image
        </button>
        <button
          type="button"
          onClick={() => status.kind === 'ready' && downloadDiffCsv(exportGtfsDiffV1(status.diffResult))}
          disabled={status.kind !== 'ready'}
          title="Export the baseline-to-current diff as a GTFS-Diff v1 CSV"
        >
          Export GTFS-Diff CSV
        </button>
        <button
          type="button"
          onClick={() => downloadTimelineTrendCsv(trendRows)}
          disabled={trendRows.length === 0}
          title="Export per-year stats as CSV"
        >
          Export stats CSV
        </button>
      </div>
    </div>
  );
}
