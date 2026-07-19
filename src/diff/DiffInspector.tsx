// Right-panel inspector for diff mode.
//
// Mirrors the timeline inspector but uses canonical ids (shared across A and
// B) as the selection unit:
//
//   - `diffStopFocus` — the canonical stop whose A/B details are shown in
//     the top card, along with a unified list of lines that served it on
//     either side (each line tagged with its own diff status).
//   - `diffRouteFocus` — the canonical route whose A/B details are shown in
//     the bottom card, along with a unified list of stops it called at on
//     either side (each stop tagged with its own diff status).
//
// Clicking a line chip in the stop card sets the route focus; clicking a
// stop chip in the route card sets the stop focus. This lets the user walk
// the network even when entities exist on only one side (e.g. inspect a
// "removed" stop and see which lines used to serve it).

import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import type { DiffResult, StopDiffEntry, RouteDiffEntry, StopSide, RouteSide } from './engine';
import { DIFF_COLOR } from './geojson';
import { SEGMENT_COLOR } from '../gtfs/segment-graph';
import { InspectorSection, LinePill, StopPill, ModeSwatch } from '../inspector/components';
import { MODE_LABEL } from '../gtfs/modes';
import { useDiffLinesForStop, useDiffStopsForRoute, type DiffRouteDirection, type DiffStopRow } from '../inspector/diff-data';

export default function DiffInspector() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const feedALabel = useAppStore((s) =>
    activeFeedId ? s.feeds[activeFeedId]?.label ?? activeFeedId : null,
  );
  const feedBLabel = useAppStore((s) =>
    compareFeedId ? s.feeds[compareFeedId]?.label ?? compareFeedId : null,
  );

  const diff = useDiff(activeFeedId, compareFeedId);

  if (diff.kind === 'no-registry') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">
          Build the Entity Registry first so diffs can line entities up across
          feeds.
        </p>
      </div>
    );
  }
  if (diff.kind === 'loading') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">Computing diff…</p>
      </div>
    );
  }
  if (diff.kind === 'error') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted" style={{ color: 'var(--removed)' }}>
          Diff failed: {diff.message}
        </p>
      </div>
    );
  }
  if (diff.kind === 'idle') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">
          Pick two feeds (A and B) in the left panel to see changes.
        </p>
      </div>
    );
  }

  const result = diff.result;
  const stopEntry = diffStopFocus
    ? result.stops.find((e) => e.canonicalId === diffStopFocus) ?? null
    : null;
  const routeEntry = diffRouteFocus
    ? result.routes.find((e) => e.canonicalId === diffRouteFocus) ?? null
    : null;

  const hasAny = Boolean(stopEntry || routeEntry);

  return (
    <div>
      <h3>Inspector</h3>
      {!hasAny && <DiffTotals result={result} />}

      {stopEntry && (
        <DiffStopCard
          entry={stopEntry}
          result={result}
          feedA={activeFeedId}
          feedB={compareFeedId}
          aLabel={feedALabel}
          bLabel={feedBLabel}
        />
      )}

      {routeEntry && (
        <DiffRouteCard
          entry={routeEntry}
          result={result}
          feedA={activeFeedId}
          feedB={compareFeedId}
          aLabel={feedALabel}
          bLabel={feedBLabel}
        />
      )}

    </div>
  );
}

function DiffTotals({ result }: { result: DiffResult }) {
  const s = result.summary.stops;
  const r = result.summary.routes;
  const totalStops = s.added + s.removed + s.moved + s.renamed + s.unchanged;
  const totalRoutes = r.added + r.removed + r.renumbered + r.modified + r.unchanged;
  return (
    <table className="diff-inspector-totals">
      <tbody>
        <tr>
          <td className="muted">Stops</td>
          <td>
            {totalStops} total · {s.added + s.removed + s.moved + s.renamed} changed
          </td>
        </tr>
        <tr>
          <td className="muted">Routes</td>
          <td>
            {totalRoutes} total · {r.added + r.removed + r.renumbered + r.modified} changed
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- stop card -------------------------------------------------------------

function DiffStopCard({
  entry,
  result,
  feedA,
  feedB,
  aLabel,
  bLabel,
}: {
  entry: StopDiffEntry;
  result: DiffResult;
  feedA: string | null;
  feedB: string | null;
  aLabel: string | null;
  bLabel: string | null;
}) {
  const setDiffStopFocus = useAppStore((s) => s.setDiffStopFocus);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);

  const linesState = useDiffLinesForStop(entry.canonicalId, feedA, feedB, result);
  const lines = linesState.status === 'ready' ? linesState.value : [];

  const nameChanged = !!entry.a && !!entry.b && entry.a.name.trim() !== entry.b.name.trim();

  return (
    <div className="inspector-card">
      <div className="inspector-card-head">
        <div className="inspector-card-kind">Stop</div>
        <StatusBadge status={entry.status} />
        <button
          type="button"
          className="inspector-card-close"
          onClick={() => setDiffStopFocus(null)}
          title="Clear stop focus"
          aria-label="Clear stop focus"
        >
          ×
        </button>
      </div>
      <div className="inspector-card-title">
        {entry.canonical.name || '(unnamed)'}
      </div>
      <div className="muted inspector-card-sub" style={{ fontFamily: 'ui-monospace, monospace' }}>
        {entry.canonicalId}
      </div>
      {entry.moved && (
        <div className="muted" style={{ marginTop: 4 }}>
          Moved {entry.distM.toFixed(0)} m
        </div>
      )}

      <div className="diff-ab">
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--a">A · {aLabel ?? '—'}</div>
          {entry.a ? (
            <StopSideTable
              side={entry.a}
              name={entry.a.name}
              highlight={{ name: nameChanged, pos: entry.moved }}
            />
          ) : (
            <div className="diff-ab-absent">not present</div>
          )}
        </div>
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--b">B · {bLabel ?? '—'}</div>
          {entry.b ? (
            <StopSideTable
              side={entry.b}
              name={entry.b.name}
              highlight={{ name: nameChanged, pos: entry.moved }}
            />
          ) : (
            <div className="diff-ab-absent">not present</div>
          )}
        </div>
      </div>

      <InspectorSection
        title="Lines"
        count={linesState.status === 'ready' ? lines.length : undefined}
      >
        {linesState.status === 'loading' && (
          <div className="muted inspector-placeholder">Loading lines…</div>
        )}
        {linesState.status === 'error' && (
          <div className="muted inspector-placeholder" style={{ color: 'var(--removed)' }}>
            Failed to load lines: {linesState.message}
          </div>
        )}
        {linesState.status === 'ready' && lines.length === 0 && (
          <div className="muted inspector-placeholder">
            No lines serve this stop on either side.
          </div>
        )}
        {linesState.status === 'ready' && lines.length > 0 && (
          <div className="line-pill-list">
            {lines.map((l) => (
              <LinePill
                key={l.canonicalId}
                line={{
                  route_short_name: l.shortName,
                  route_long_name: l.longName,
                  agency_name: l.agency,
                  mode: l.mode,
                  trip_count: Math.max(l.aTripCount, l.bTripCount),
                }}
                status={l.status}
                selected={l.canonicalId === diffRouteFocus}
                onClick={() => setDiffRouteFocus(l.canonicalId)}
              />
            ))}
          </div>
        )}
      </InspectorSection>
    </div>
  );
}

function StopSideTable({
  side,
  name,
  highlight,
}: {
  side: StopSide;
  name: string;
  highlight: { name: boolean; pos: boolean };
}) {
  return (
    <table className="diff-ab-table">
      <tbody>
        <tr className={highlight.name ? 'changed' : ''}>
          <td className="muted">Name</td>
          <td>{name || '(unnamed)'}</td>
        </tr>
        <tr className={highlight.pos ? 'changed' : ''}>
          <td className="muted">Lat</td>
          <td>{side.lat.toFixed(5)}</td>
        </tr>
        <tr className={highlight.pos ? 'changed' : ''}>
          <td className="muted">Lon</td>
          <td>{side.lon.toFixed(5)}</td>
        </tr>
        <tr>
          <td className="muted">Raw IDs</td>
          <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>
            {side.rawIds.join(', ') || '—'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- route card ------------------------------------------------------------

function DiffRouteCard({
  entry,
  result,
  feedA,
  feedB,
  aLabel,
  bLabel,
}: {
  entry: RouteDiffEntry;
  result: DiffResult;
  feedA: string | null;
  feedB: string | null;
  aLabel: string | null;
  bLabel: string | null;
}) {
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffStopFocus = useAppStore((s) => s.setDiffStopFocus);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const diffRouteCandidates = useAppStore((s) => s.diffRouteCandidates);
  const diffRouteFocusGeomStatus = useAppStore((s) => s.diffRouteFocusGeomStatus);
  const requestDiffRouteZoom = useAppStore((s) => s.requestDiffRouteZoom);
  const diffRoutesWithGeomChange = useAppStore((s) => s.diffRoutesWithGeomChange);
  const geomChangedElsewhere =
    entry.status === 'unchanged' && !!diffRoutesWithGeomChange?.has(entry.canonicalId);

  const otherCandidates = diffRouteCandidates
    .filter((cid) => cid !== entry.canonicalId)
    .map((cid) => result.routes.find((r) => r.canonicalId === cid))
    .filter((r): r is RouteDiffEntry => !!r);

  const stopsState = useDiffStopsForRoute(entry.canonicalId, feedA, feedB, result);
  const directions = stopsState.status === 'ready' ? stopsState.directions : [];

  const [courseIdx, setCourseIdx] = useState(0);
  useEffect(() => {
    setCourseIdx(0);
  }, [entry.canonicalId]);
  const course = directions.length > 0
    ? directions[Math.min(courseIdx, directions.length - 1)]
    : null;

  const a = entry.a;
  const b = entry.b;
  const highlight = {
    short: !!a && !!b && a.shortName !== b.shortName,
    long: !!a && !!b && a.longName !== b.longName,
    agency: !!a && !!b && a.agencyName !== b.agencyName,
    mode: !!a && !!b && a.mode !== b.mode,
  };

  return (
    <div className="inspector-card">
      <div className="inspector-card-head">
        <div className="inspector-card-kind">Line</div>
        {!geomChangedElsewhere && <StatusBadge status={entry.status} />}
        <div className="inspector-card-head-actions">
          <button
            type="button"
            className="inspector-card-zoom"
            onClick={() => requestDiffRouteZoom()}
            title="Zoom the map to this line's full extent"
          >
            Show full line
          </button>
          <button
            type="button"
            className="inspector-card-close"
            onClick={() => setDiffRouteFocus(null)}
            title="Clear line focus"
            aria-label="Clear line focus"
          >
            ×
          </button>
        </div>
      </div>
      <div className="inspector-card-title">
        {entry.canonical.shortName || entry.canonical.longName || '(unnamed route)'}
      </div>
      <div className="inspector-card-meta">
        <ModeSwatch mode={entry.canonical.mode} size={12} />
        <span>{MODE_LABEL[entry.canonical.mode]}</span>
      </div>
      <div className="muted inspector-card-sub" style={{ fontFamily: 'ui-monospace, monospace' }}>
        {entry.canonicalId}
      </div>
      {entry.renumbering && (
        <div className="muted" style={{ marginTop: 4 }}>
          Renumbered: <code>{entry.renumbering.fromCanonicalId}</code> → <code>{entry.renumbering.toCanonicalId}</code>
        </div>
      )}
      {diffRouteFocusGeomStatus && diffRouteFocusGeomStatus !== 'unchanged' && (
        <div
          className="diff-status-badge"
          style={{
            marginTop: 4,
            background: `${SEGMENT_COLOR[diffRouteFocusGeomStatus]}22`,
            color: SEGMENT_COLOR[diffRouteFocusGeomStatus],
            borderColor: `${SEGMENT_COLOR[diffRouteFocusGeomStatus]}55`,
          }}
        >
          {diffRouteFocusGeomStatus === 'added' ? 'new track — only in feed B'
            : diffRouteFocusGeomStatus === 'changed' ? 'rerouted — old and new path nearby'
            : 'removed track — only in feed A'}
        </div>
      )}

      {otherCandidates.length > 0 && (
        <InspectorSection title="Other lines on this segment" count={otherCandidates.length}>
          <div className="line-pill-list">
            {otherCandidates.map((r) => (
              <LinePill
                key={r.canonicalId}
                line={{
                  route_short_name: r.canonical.shortName,
                  route_long_name: r.canonical.longName,
                  agency_name: (r.a ?? r.b)?.agencyName ?? '',
                  mode: r.canonical.mode,
                  trip_count: 0,
                }}
                status={r.status}
                selected={false}
                onClick={() => setDiffRouteFocus(r.canonicalId, diffRouteCandidates)}
              />
            ))}
          </div>
        </InspectorSection>
      )}

      <InspectorSection title="Details" defaultCollapsed>
        <div className="diff-ab">
          <div className="diff-ab-col">
            <div className="diff-ab-head diff-ab-head--a">A · {aLabel ?? '—'}</div>
            {a ? <RouteSideTable side={a} highlight={highlight} /> : <div className="diff-ab-absent">not present</div>}
          </div>
          <div className="diff-ab-col">
            <div className="diff-ab-head diff-ab-head--b">B · {bLabel ?? '—'}</div>
            {b ? <RouteSideTable side={b} highlight={highlight} /> : <div className="diff-ab-absent">not present</div>}
          </div>
        </div>
      </InspectorSection>

      <InspectorSection
        title="Stops"
        count={stopsSectionCount(stopsState.status, course)}
        defaultCollapsed
      >
        {stopsState.status === 'loading' && (
          <div className="muted inspector-placeholder">Loading stops…</div>
        )}
        {stopsState.status === 'error' && (
          <div className="muted inspector-placeholder" style={{ color: 'var(--removed)' }}>
            Failed to load stops: {stopsState.message}
          </div>
        )}
        {stopsState.status === 'ready' && directions.length === 0 && (
          <div className="muted inspector-placeholder">
            No stops found for this line.
          </div>
        )}

        {stopsState.status === 'ready' && course && (
          <DirectionPairBody
            course={course}
            courseIdx={Math.min(courseIdx, directions.length - 1)}
            totalCourses={directions.length}
            onToggle={() => setCourseIdx((i) => (i + 1) % directions.length)}
            diffStopFocus={diffStopFocus}
            onStopClick={(s) => { if (s.canonicalId) setDiffStopFocus(s.canonicalId); }}
          />
        )}
      </InspectorSection>
    </div>
  );
}

function stopsSectionCount(
  status: 'loading' | 'ready' | 'error',
  course: DiffRouteDirection | null,
): string | undefined {
  if (status !== 'ready' || !course) return undefined;
  const a = course.aStops.length;
  const b = course.bStops.length;
  return a === b ? `${a}` : `${a} / ${b}`;
}

/**
 * Direction-paired stops body: pager header + two parallel numbered columns,
 * one per side. Stops with `directionRole: 'only-here'` get an added/removed
 * tint against the other column so it's visually obvious which side the stop
 * belongs to in this direction, even when the stop itself is "unchanged".
 */
function DirectionPairBody({
  course,
  courseIdx,
  totalCourses,
  onToggle,
  diffStopFocus,
  onStopClick,
}: {
  course: DiffRouteDirection;
  courseIdx: number;
  totalCourses: number;
  onToggle: () => void;
  diffStopFocus: string | null;
  onStopClick: (s: DiffStopRow) => void;
}) {
  return (
    <>
      <div className="route-course">
        <div className="route-course-head">
          <div>
            <div className="muted route-course-label">
              Course {courseIdx + 1} / {totalCourses}
              {course.direction_id != null && <> · dir {course.direction_id}</>}
            </div>
            <div className="route-course-headsign">
              <span title={course.headsignA}>A → {course.headsignA || '—'}</span>
              <span className="muted" style={{ margin: '0 6px' }}>|</span>
              <span title={course.headsignB}>B → {course.headsignB || '—'}</span>
            </div>
            <div className="muted route-course-trips">
              ~{course.tripCountA.toLocaleString()} A trips · ~{course.tripCountB.toLocaleString()} B trips
            </div>
          </div>
          {totalCourses > 1 && (
            <button
              type="button"
              className="route-course-toggle"
              onClick={onToggle}
              title="Show other direction"
            >
              Other direction
            </button>
          )}
        </div>
      </div>

      <div className="diff-ab" style={{ marginTop: 8 }}>
        <DirectionColumn
          header="A"
          tone="a"
          stops={course.aStops}
          diffStopFocus={diffStopFocus}
          onStopClick={onStopClick}
          absentSideLabel="not present on A"
        />
        <DirectionColumn
          header="B"
          tone="b"
          stops={course.bStops}
          diffStopFocus={diffStopFocus}
          onStopClick={onStopClick}
          absentSideLabel="not present on B"
        />
      </div>
    </>
  );
}

function DirectionColumn({
  header,
  tone,
  stops,
  diffStopFocus,
  onStopClick,
  absentSideLabel,
}: {
  header: string;
  tone: 'a' | 'b';
  stops: DiffStopRow[];
  diffStopFocus: string | null;
  onStopClick: (s: DiffStopRow) => void;
  absentSideLabel: string;
}) {
  return (
    <div className="diff-ab-col">
      <div className={`diff-ab-head diff-ab-head--${tone}`}>{header}</div>
      {stops.length === 0 ? (
        <div className="diff-ab-absent">{absentSideLabel}</div>
      ) : (
        <div className="stop-pill-list" style={{ padding: 6 }}>
          {stops.map((s) => {
            // Pick the most informative tint for the pill: registry status
            // first (added/removed/moved/…), then "only on this side of the
            // direction" which we map to added/removed depending on tone.
            const pillStatus =
              s.status ??
              (s.directionRole === 'only-here'
                ? tone === 'a'
                  ? 'removed'
                  : 'added'
                : null);
            return (
              <StopPill
                key={`${tone}:${s.seq}:${s.stopId}`}
                stopId={s.stopId}
                stopName={s.stopName}
                seq={s.seq}
                idTag={s.stopId}
                status={pillStatus}
                selected={!!s.canonicalId && s.canonicalId === diffStopFocus}
                onClick={() => onStopClick(s)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function RouteSideTable({
  side,
  highlight,
}: {
  side: RouteSide;
  highlight: { short: boolean; long: boolean; agency: boolean; mode: boolean };
}) {
  return (
    <table className="diff-ab-table">
      <tbody>
        <tr className={highlight.short ? 'changed' : ''}>
          <td className="muted">Short</td>
          <td>{side.shortName || '—'}</td>
        </tr>
        <tr className={highlight.long ? 'changed' : ''}>
          <td className="muted">Long</td>
          <td>{side.longName || '—'}</td>
        </tr>
        <tr className={highlight.agency ? 'changed' : ''}>
          <td className="muted">Agency</td>
          <td>{side.agencyName || '—'}</td>
        </tr>
        <tr className={highlight.mode ? 'changed' : ''}>
          <td className="muted">Mode</td>
          <td>{side.mode}</td>
        </tr>
        <tr>
          <td className="muted">Raw IDs</td>
          <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>
            {side.rawIds.join(', ') || '—'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- helpers ---------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const color = DIFF_COLOR[status as keyof typeof DIFF_COLOR] ?? '#94a3b8';
  return (
    <span
      className="diff-status-badge"
      style={{ background: `${color}22`, color, borderColor: `${color}55` }}
    >
      {status}
    </span>
  );
}
