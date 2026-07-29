// Legend for the ÖV-Güteklassen analysis overlay — structural mirror of
// PopulationLegend.tsx. Unlike population's percentile-scaled classes, A-G
// are fixed intrinsic categories, so there's no "capped at 95th percentile"
// caveat here; the caveat that does matter is the methodology's two
// documented simplifications (see gtfs/gueteklassen.ts's file header).

import { useAppStore } from '../state/app-store';
import { DiffStationsSection, FeedStationsSection } from './PopulationLegend';
import { GUTEKLASSE_COLOR, GUTEKLASSE_LETTER, type GueteklassenSummary } from '../gtfs/gueteklassen';
import { GUETEKLASSEN_CHANGE_COLOR, type GueteklassenChangeSummary } from './gueteklassen';

function GuteklasseHeader() {
  return <div className="frequency-legend-header">ÖV-Güteklassen</div>;
}

function GuteklasseSourceNote() {
  return (
    <div className="muted frequency-legend-caption">
      Source: <a
        href="https://www.mobilitydata.gv.at/daten/%C3%B6v-g%C3%BCteklassen"
        target="_blank"
        rel="noopener noreferrer"
      >
        ÖROK
      </a>
    </div>
  );
}

function GuteklasseBlock({ summary, caption }: { summary: GueteklassenSummary; caption?: string }) {
  const { classCounts, noCoverageCount, cellCount } = summary;
  const coveragePct = cellCount > 0 ? Math.round(((cellCount - noCoverageCount) / cellCount) * 100) : 0;
  return (
    <div className="frequency-legend">
      <div className="frequency-legend-classes">
        {GUTEKLASSE_LETTER.map((letter, i) => (
          <div className="frequency-legend-class" key={letter}>
            <span className="frequency-legend-swatch" style={{ background: GUTEKLASSE_COLOR[i as 0 | 1 | 2 | 3 | 4 | 5 | 6] }} />
            <span>
              {letter} ({classCounts[i as 0 | 1 | 2 | 3 | 4 | 5 | 6]})
            </span>
          </div>
        ))}
      </div>
      <div className="muted frequency-legend-caption">
        {caption ? `${caption} — ` : ''}
        {coveragePct}% coverage
      </div>
    </div>
  );
}

const CHANGE_LABEL: Record<keyof GueteklassenChangeSummary['changeCounts'], string> = {
  improved: 'Improved',
  degraded: 'Degraded',
  unchanged: 'Unchanged',
  gained: 'Gained coverage',
  lost: 'Lost coverage',
};

function GuteklasseChangeBlock({ summary }: { summary: GueteklassenChangeSummary }) {
  return (
    <div className="frequency-legend">
      <div className="frequency-legend-classes">
        {(Object.keys(CHANGE_LABEL) as (keyof typeof CHANGE_LABEL)[]).map((key) => (
          <div className="frequency-legend-class" key={key}>
            <span className="frequency-legend-swatch" style={{ background: GUETEKLASSEN_CHANGE_COLOR[key] }} />
            <span>
              {CHANGE_LABEL[key]} ({summary.changeCounts[key]})
            </span>
          </div>
        ))}
      </div>
      <div className="muted frequency-legend-caption">
        {summary.feedA} → {summary.feedB}
      </div>
    </div>
  );
}

export function GueteklassenLegend() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const splitSummary = useAppStore((s) => s.splitGueteklassenSummary);
  const diffChangeSummary = useAppStore((s) => s.diffGueteklassenSummary);
  const feedSummary = useAppStore((s) => s.feedGueteklassenSummary);

  if (diffOverviewLayout === 'split') {
    if (!splitSummary.a || !splitSummary.b) {
      return <div className="muted frequency-legend-caption">Computing ÖV-Güteklassen…</div>;
    }
    return (
      <>
        <GuteklasseHeader />
        <GuteklasseBlock summary={splitSummary.a} caption="Left" />
        <GuteklasseBlock summary={splitSummary.b} caption="Right" />
        <GuteklasseSourceNote />
        <DiffStationsSection />
      </>
    );
  }

  if (diffChangeSummary) {
    return (
      <>
        <GuteklasseHeader />
        <GuteklasseChangeBlock summary={diffChangeSummary} />
        <GuteklasseSourceNote />
        <DiffStationsSection />
      </>
    );
  }

  if (feedSummary) {
    return (
      <>
        <GuteklasseHeader />
        <GuteklasseBlock summary={feedSummary} />
        <GuteklasseSourceNote />
        <FeedStationsSection />
      </>
    );
  }

  return <div className="muted frequency-legend-caption">Computing ÖV-Güteklassen…</div>;
}
