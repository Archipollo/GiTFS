// Shared legend for the frequency analysis overlay — used by every view that
// can render it (network overview, split view, route detail, single-feed
// map). Reads the summary the map already computed straight from the store
// (`diffFrequencySummary` for a diff pair, `feedFrequencySummary` for a lone
// feed) so every caller renders the same thing with no props.
//
// A flat 3-swatch legend (down/flat/up) only names the *direction* of a
// change — it can't say whether "more frequent" means +2 trips/week or
// +2,000. Both map layers now bucket into 5 discrete classes (rather than a
// continuous gradient), so this renders 5 swatches labelled with the actual
// trips/week value at each class boundary.

import { useState } from 'react';
import { useAppStore } from '../state/app-store';
import {
  FREQUENCY_BIG_LOSS_COLOR,
  FREQUENCY_SMALL_LOSS_COLOR,
  FREQUENCY_NEUTRAL_COLOR,
  FREQUENCY_SMALL_GAIN_COLOR,
  FREQUENCY_BIG_GAIN_COLOR,
  FREQUENCY_CLASS_BREAKS,
} from './frequency';
import {
  FEED_FREQUENCY_LOWEST_COLOR,
  FEED_FREQUENCY_LOW_COLOR,
  FEED_FREQUENCY_MID_COLOR,
  FEED_FREQUENCY_HIGH_COLOR,
  FEED_FREQUENCY_HIGHEST_COLOR,
  FEED_FREQUENCY_CLASS_BREAKS,
} from '../gtfs/frequency';
import { DIFF_COLOR, STOP_LEGEND } from './geojson';

function fmt(n: number): string {
  // No thousands grouping — `toLocaleString()` inserts a locale-dependent
  // separator (a space in some locales), which reads as two numbers.
  return String(Math.round(n));
}

function StationsSection() {
  const [open, setOpen] = useState(false);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const toggleDiffStopLabels = useAppStore((s) => s.toggleDiffStopLabels);
  return (
    <div className="frequency-legend-stations">
      <button
        type="button"
        className="frequency-legend-stations-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Stations
      </button>
      {open && (
        <div className="frequency-legend-stations-body">
          {STOP_LEGEND.map(({ id, label }) => (
            <label key={id} className={`diff-count ${diffStopVisibility[id] ? 'on' : 'off'}`}>
              <input
                type="checkbox"
                checked={diffStopVisibility[id]}
                onChange={() => toggleDiffStopVisibility(id)}
              />
              <span className="diff-count-swatch" style={{ background: DIFF_COLOR[id] }} />
              <span className="diff-count-label">{label}</span>
            </label>
          ))}
          <label className={`diff-count ${diffStopLabels ? 'on' : 'off'}`}>
            <input type="checkbox" checked={diffStopLabels} onChange={toggleDiffStopLabels} />
            <span className="diff-count-swatch diff-count-swatch--label">A</span>
            <span className="diff-count-label">Station names</span>
          </label>
        </div>
      )}
    </div>
  );
}

function FeedStationsSection() {
  const [open, setOpen] = useState(false);
  const showStops = useAppStore((s) => s.showStops);
  const setShowStops = useAppStore((s) => s.setShowStops);
  return (
    <div className="frequency-legend-stations">
      <button
        type="button"
        className="frequency-legend-stations-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Stations
      </button>
      {open && (
        <div className="frequency-legend-stations-body">
          <label className={`diff-count ${showStops ? 'on' : 'off'}`}>
            <input type="checkbox" checked={showStops} onChange={(e) => setShowStops(e.target.checked)} />
            <span className="diff-count-label">Stations</span>
          </label>
        </div>
      )}
    </div>
  );
}

export function FrequencyLegend() {
  const diffSummary = useAppStore((s) => s.diffFrequencySummary);
  const feedSummary = useAppStore((s) => s.feedFrequencySummary);
  const frequencyIncludeAddedRemoved = useAppStore((s) => s.frequencyIncludeAddedRemoved);
  const setFrequencyIncludeAddedRemoved = useAppStore((s) => s.setFrequencyIncludeAddedRemoved);

  if (diffSummary) {
    const { scaleAbsDelta, maxAbsDelta } = diffSummary;
    const capped = maxAbsDelta > scaleAbsDelta;
    const [b0, b1, b2, b3] = FREQUENCY_CLASS_BREAKS.map((f) => f * scaleAbsDelta);
    const classes = [
      { color: FREQUENCY_BIG_LOSS_COLOR, label: `≤ −${fmt(-b0)}/wk` },
      { color: FREQUENCY_SMALL_LOSS_COLOR, label: `−${fmt(-b0)} to −${fmt(-b1)}/wk` },
      { color: FREQUENCY_NEUTRAL_COLOR, label: `−${fmt(-b1)} to +${fmt(b2)}/wk` },
      { color: FREQUENCY_SMALL_GAIN_COLOR, label: `+${fmt(b2)} to +${fmt(b3)}/wk` },
      { color: FREQUENCY_BIG_GAIN_COLOR, label: `≥ +${fmt(b3)}/wk` },
    ];
    return (
      <div className="frequency-legend">
        <div className="frequency-legend-classes">
          {classes.map((c) => (
            <div className="frequency-legend-class" key={c.label}>
              <span className="frequency-legend-swatch" style={{ background: c.color }} />
              <span>{c.label}</span>
            </div>
          ))}
        </div>
        <label className="frequency-legend-toggle">
          <input
            type="checkbox"
            checked={frequencyIncludeAddedRemoved}
            onChange={(e) => setFrequencyIncludeAddedRemoved(e.target.checked)}
          />
          Include added/removed lines
        </label>
        <div className="muted frequency-legend-caption">
          Trips/week gained or lost - line width also scales with the size of the change
          {capped && ` (classes capped at the 95th percentile; largest change is ${fmt(maxAbsDelta)}/wk)`}
        </div>
        <StationsSection />
      </div>
    );
  }

  if (feedSummary) {
    const { scaleWeeklyTrips, maxWeeklyTrips } = feedSummary;
    const capped = maxWeeklyTrips > scaleWeeklyTrips;
    const [b0, b1, b2, b3] = FEED_FREQUENCY_CLASS_BREAKS.map((f) => f * scaleWeeklyTrips);
    const classes = [
      { color: FEED_FREQUENCY_LOWEST_COLOR, label: `0 to ${fmt(b0)}/wk` },
      { color: FEED_FREQUENCY_LOW_COLOR, label: `${fmt(b0)} to ${fmt(b1)}/wk` },
      { color: FEED_FREQUENCY_MID_COLOR, label: `${fmt(b1)} to ${fmt(b2)}/wk` },
      { color: FEED_FREQUENCY_HIGH_COLOR, label: `${fmt(b2)} to ${fmt(b3)}/wk` },
      { color: FEED_FREQUENCY_HIGHEST_COLOR, label: `≥ ${fmt(b3)}/wk` },
    ];
    return (
      <div className="frequency-legend">
        <div className="frequency-legend-classes">
          {classes.map((c) => (
            <div className="frequency-legend-class" key={c.label}>
              <span className="frequency-legend-swatch" style={{ background: c.color }} />
              <span>{c.label}</span>
            </div>
          ))}
        </div>
        <div className="muted frequency-legend-caption">
          Trips/week per line · line width also scales with frequency
          {capped && ` (classes capped at the 95th percentile; busiest line runs ${fmt(maxWeeklyTrips)}/wk)`}
        </div>
        <FeedStationsSection />
      </div>
    );
  }

  return (
    <div className="muted frequency-legend-caption">Computing frequency…</div>
  );
}
