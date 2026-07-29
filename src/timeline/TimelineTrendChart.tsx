// Hand-rolled inline-SVG trend chart for the Timeline view — plots one
// metric (stops/routes/trips/weekly trips) across every loaded feed-year.
// No charting library exists in the project and a handful of series doesn't
// warrant adding one; SVG (not canvas) also makes the export a lossless
// vector file, better suited to a thesis document than a raster PNG.

import { useRef, useState } from 'react';
import { useAppStore } from '../state/app-store';
import type { TimelineYearRow } from './timelineExport';

export const TREND_LINE_COLOR = '#2d6cdf';
export const TREND_POINT_COLOR = '#1b4a9e';
export const TREND_AXIS_COLOR = '#9ca3af';

type Metric = 'stops' | 'routes' | 'trips' | 'weeklyTrips';
type Mode = 'absolute' | 'sinceBaseline';

const METRIC_LABEL: Record<Metric, string> = {
  stops: 'Stops',
  routes: 'Routes',
  trips: 'Trips',
  weeklyTrips: 'Trips / week',
};

function metricValue(row: TimelineYearRow, metric: Metric): number | null {
  switch (metric) {
    case 'stops': return row.stopCount;
    case 'routes': return row.routeCount;
    case 'trips': return row.tripCount;
    case 'weeklyTrips': return row.totalWeeklyTrips;
  }
}

const WIDTH = 320;
const HEIGHT = 140;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

export function TimelineTrendChart({ rows, baselineIndex = null }: { rows: TimelineYearRow[]; baselineIndex?: number | null }) {
  const [metric, setMetric] = useState<Metric>('stops');
  // Shared with the map growth/loss overlay and the change panel, so
  // switching it here also re-bases those.
  const timelineCumulativeMode = useAppStore((s) => s.timelineCumulativeMode);
  const setTimelineCumulativeMode = useAppStore((s) => s.setTimelineCumulativeMode);
  const mode: Mode = timelineCumulativeMode ? 'sinceBaseline' : 'absolute';
  const svgRef = useRef<SVGSVGElement | null>(null);

  // "Since baseline" re-bases every value against the baseline row so the
  // chart reads as cumulative growth from that year onward (0 at baseline)
  // instead of each year's raw count in isolation.
  const baselineValue = baselineIndex != null ? metricValue(rows[baselineIndex], metric) : null;
  const effectiveMode: Mode = mode === 'sinceBaseline' && baselineValue != null ? 'sinceBaseline' : 'absolute';

  const values = rows.map((r) => {
    const v = metricValue(r, metric);
    if (v == null) return null;
    return effectiveMode === 'sinceBaseline' ? v - (baselineValue as number) : v;
  });
  const known = values.filter((v): v is number => v != null);
  const maxV = known.length > 0 ? Math.max(...known, effectiveMode === 'sinceBaseline' ? 0 : 1) : 1;
  const minV = known.length > 0 ? Math.min(...known, 0) : 0;

  const plotW = WIDTH - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;

  const xFor = (i: number) => PAD_L + (rows.length <= 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const yFor = (v: number) => PAD_T + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;

  const points = rows.map((r, i) => ({ x: xFor(i), y: values[i] != null ? yFor(values[i]!) : null, row: r, value: values[i] }));
  const known2 = points.filter((p): p is { x: number; y: number; row: TimelineYearRow; value: number } => p.y != null);
  const path = known2.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const zeroY = minV <= 0 && maxV >= 0 ? yFor(0) : null;

  const handleExport = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const markup = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gitfs-timeline-trend-${metric}-${effectiveMode}.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="timeline-trend-chart">
      <div className="timeline-trend-chart-head">
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
          aria-label="Trend metric"
        >
          {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
            <option key={m} value={m}>{METRIC_LABEL[m]}</option>
          ))}
        </select>
        <select
          value={mode}
          onChange={(e) => setTimelineCumulativeMode(e.target.value === 'sinceBaseline')}
          disabled={baselineIndex == null}
          aria-label="Trend mode"
          title={baselineIndex == null ? 'Pick a baseline to enable cumulative view' : undefined}
        >
          <option value="absolute">Per year</option>
          <option value="sinceBaseline">Cumulative since baseline</option>
        </select>
        <button type="button" onClick={handleExport} disabled={rows.length === 0}>
          Export chart (SVG)
        </button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label={`${METRIC_LABEL[metric]} trend across loaded years`}>
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke={TREND_AXIS_COLOR} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke={TREND_AXIS_COLOR} strokeWidth={1} />
        {zeroY != null && zeroY !== PAD_T + plotH && (
          <line x1={PAD_L} y1={zeroY} x2={PAD_L + plotW} y2={zeroY} stroke={TREND_AXIS_COLOR} strokeWidth={1} strokeDasharray="2,2" />
        )}
        <text x={PAD_L - 4} y={PAD_T + 4} textAnchor="end" fontSize={9} fill={TREND_AXIS_COLOR}>{maxV}</text>
        <text x={PAD_L - 4} y={PAD_T + plotH} textAnchor="end" fontSize={9} fill={TREND_AXIS_COLOR}>{minV}</text>
        {path && <path d={path} fill="none" stroke={TREND_LINE_COLOR} strokeWidth={2} />}
        {known2.map((p) => (
          <circle key={p.row.year + p.row.feedLabel} cx={p.x} cy={p.y} r={3} fill={TREND_POINT_COLOR}>
            <title>{`${p.row.year} · ${p.row.feedLabel}: ${p.value >= 0 && effectiveMode === 'sinceBaseline' ? '+' : ''}${p.value}`}</title>
          </circle>
        ))}
        {rows.map((r, i) => (
          <text key={r.year + r.feedLabel} x={xFor(i)} y={HEIGHT - 6} textAnchor="middle" fontSize={9} fill={TREND_AXIS_COLOR}>
            {r.year}
          </text>
        ))}
      </svg>
    </div>
  );
}
