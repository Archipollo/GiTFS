// Shared legend for the population analysis overlay — mirrors
// FrequencyLegend.tsx's "read a store-computed summary, render swatches"
// shape so every view (network overview, split view, single-feed map) shows
// the same thing with no props. Reads `diffPopulationSummary` for a diff
// pair, `feedPopulationSummary` for a lone feed.

import { useState } from 'react';
import { useAppStore } from '../state/app-store';
import { DIFF_COLOR, STOP_LEGEND } from './geojson';
import {
  POPULATION_BIG_LOSS_COLOR,
  POPULATION_SMALL_LOSS_COLOR,
  POPULATION_NEUTRAL_COLOR,
  POPULATION_SMALL_GAIN_COLOR,
  POPULATION_BIG_GAIN_COLOR,
  POPULATION_DIFF_CLASS_BREAKS,
} from './population';
import {
  POPULATION_LOWEST_COLOR,
  POPULATION_LOW_COLOR,
  POPULATION_MID_COLOR,
  POPULATION_HIGH_COLOR,
  POPULATION_HIGHEST_COLOR,
  POPULATION_CLASS_BREAKS,
  type PopulationSummary,
} from '../gtfs/population';

function fmt(n: number): string {
  return String(Math.round(n));
}

function DiffStationsSection() {
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

/** One sequential-scale legend block (5 classes + caption) for an absolute
 * per-cell population summary — shared by the single-feed case and split
 * view's two per-pane blocks below. */
function AbsolutePopulationBlock({ summary, caption }: { summary: PopulationSummary; caption: string }) {
  const { scalePopulation, maxPopulation } = summary;
  const capped = maxPopulation > scalePopulation;
  const [b0, b1, b2, b3] = POPULATION_CLASS_BREAKS.map((f) => f * scalePopulation);
  const classes = [
    { color: POPULATION_LOWEST_COLOR, label: `0 to ${fmt(b0)}` },
    { color: POPULATION_LOW_COLOR, label: `${fmt(b0)} to ${fmt(b1)}` },
    { color: POPULATION_MID_COLOR, label: `${fmt(b1)} to ${fmt(b2)}` },
    { color: POPULATION_HIGH_COLOR, label: `${fmt(b2)} to ${fmt(b3)}` },
    { color: POPULATION_HIGHEST_COLOR, label: `≥ ${fmt(b3)}` },
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
        {caption}
        {capped && ` (classes capped at the 95th percentile; densest cell has ${fmt(maxPopulation)})`}
      </div>
    </div>
  );
}

export function PopulationLegend() {
  const populationSource = useAppStore((s) => s.populationSource);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const diffSummary = useAppStore((s) => s.diffPopulationSummary);
  const feedSummary = useAppStore((s) => s.feedPopulationSummary);
  const splitSummary = useAppStore((s) => s.splitPopulationSummary);
  const zaehlsprengelSummary = useAppStore((s) => s.zaehlsprengelPopulationSummary);

  if (populationSource === 'zsp') {
    if (!zaehlsprengelSummary) {
      return <div className="muted frequency-legend-caption">Computing population…</div>;
    }
    const { scalePopulation, maxPopulation, year, unitCount } = zaehlsprengelSummary;
    const capped = maxPopulation > scalePopulation;
    const [b0, b1, b2, b3] = POPULATION_CLASS_BREAKS.map((f) => f * scalePopulation);
    const classes = [
      { color: POPULATION_LOWEST_COLOR, label: `0 to ${fmt(b0)}` },
      { color: POPULATION_LOW_COLOR, label: `${fmt(b0)} to ${fmt(b1)}` },
      { color: POPULATION_MID_COLOR, label: `${fmt(b1)} to ${fmt(b2)}` },
      { color: POPULATION_HIGH_COLOR, label: `${fmt(b2)} to ${fmt(b3)}` },
      { color: POPULATION_HIGHEST_COLOR, label: `≥ ${fmt(b3)}` },
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
          People per Zählsprengel ({unitCount} units, Statistik Austria registry, {year})
          {capped && ` (classes capped at the 95th percentile; densest unit has ${fmt(maxPopulation)})`}
        </div>
      </div>
    );
  }

  // Split view shows each pane's own year as raw numbers, never a diff — see
  // SplitMapView's population effect. Checked ahead of the diff-pair branches
  // below so a stale `diffPopulationSummary` from a prior network-overview
  // visit can't leak into split view's legend.
  if (diffOverviewLayout === 'split') {
    if (!splitSummary.a || !splitSummary.b) {
      return <div className="muted frequency-legend-caption">Computing population…</div>;
    }
    return (
      <>
        <AbsolutePopulationBlock
          summary={splitSummary.a}
          caption={`Left: people per ~100m cell (${splitSummary.a.year}, GHS-POP)`}
        />
        <AbsolutePopulationBlock
          summary={splitSummary.b}
          caption={`Right: people per ~100m cell (${splitSummary.b.year}, GHS-POP)`}
        />
        <DiffStationsSection />
      </>
    );
  }

  if (diffSummary?.mode === 'absolute') {
    const { scalePopulation, maxPopulation, yearB } = diffSummary;
    const capped = maxPopulation > scalePopulation;
    const [b0, b1, b2, b3] = POPULATION_CLASS_BREAKS.map((f) => f * scalePopulation);
    const classes = [
      { color: POPULATION_LOWEST_COLOR, label: `0 to ${fmt(b0)}` },
      { color: POPULATION_LOW_COLOR, label: `${fmt(b0)} to ${fmt(b1)}` },
      { color: POPULATION_MID_COLOR, label: `${fmt(b1)} to ${fmt(b2)}` },
      { color: POPULATION_HIGH_COLOR, label: `${fmt(b2)} to ${fmt(b3)}` },
      { color: POPULATION_HIGHEST_COLOR, label: `≥ ${fmt(b3)}` },
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
          Same GHS-POP year on both sides ({yearB}) — showing people per ~100m cell
          {capped && ` (classes capped at the 95th percentile; densest cell has ${fmt(maxPopulation)})`}
        </div>
        <DiffStationsSection />
      </div>
    );
  }

  if (diffSummary) {
    const { maxAbsDelta, yearA, yearB } = diffSummary;
    const [b0, b1, b2, b3] = POPULATION_DIFF_CLASS_BREAKS;
    const capped = maxAbsDelta > b3;
    const classes = [
      { color: POPULATION_BIG_LOSS_COLOR, label: `≤ −${fmt(-b0)}` },
      { color: POPULATION_SMALL_LOSS_COLOR, label: `−${fmt(-b0)} to −${fmt(-b1)}` },
      { color: POPULATION_NEUTRAL_COLOR, label: `−${fmt(-b1)} to +${fmt(b2)}` },
      { color: POPULATION_SMALL_GAIN_COLOR, label: `+${fmt(b2)} to +${fmt(b3)}` },
      { color: POPULATION_BIG_GAIN_COLOR, label: `≥ +${fmt(b3)}` },
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
          People gained or lost per ~100m cell, {yearA} → {yearB} (GHS-POP)
          {capped && ` (largest change is ${fmt(maxAbsDelta)})`}
        </div>
        <DiffStationsSection />
      </div>
    );
  }

  if (feedSummary) {
    return (
      <>
        <AbsolutePopulationBlock
          summary={feedSummary}
          caption={`People per ~100m cell (${feedSummary.year}, GHS-POP)`}
        />
        <FeedStationsSection />
      </>
    );
  }

  return (
    <div className="muted frequency-legend-caption">Computing population…</div>
  );
}
