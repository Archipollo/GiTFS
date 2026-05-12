// Timeline-mode inspector card for a single route in the active feed.
//
// Renders:
//   - route short/long name + agency + mode badge
//   - a "Course X / N · Headsign" selector with an "Other direction" button
//   - the stops of the selected direction's representative trip, in real
//     sequence order; clicking a stop chip opens it in the Stop inspector
//     above this card.
//
// The list of lines that should be visible on the map overlay is decided by
// `MapView.tsx`; this card only contributes a click handler.

import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useRegistry } from '../registry/useRegistry';
import type { LineForStop } from '../gtfs/queries';
import { getLinesForStop, getRouteDirections, useRouteDirections } from './data';
import { InspectorSection, ModeSwatch, StopPill } from './components';
import { MODE_LABEL } from '../gtfs/modes';

export default function RouteCard() {
  const route = useAppStore((s) => s.inspectorRoute);
  const stop = useAppStore((s) => s.inspectorStop);
  const setInspectorStop = useAppStore((s) => s.setInspectorStop);
  const setInspectorRoute = useAppStore((s) => s.setInspectorRoute);
  const registry = useRegistry();

  const dirsState = useRouteDirections(route?.feedId ?? null, route?.rawId ?? null);

  // Which direction is the user looking at? Reset whenever the route changes
  // so each newly-opened line starts at "Course 1 / N".
  const [courseIdx, setCourseIdx] = useState(0);
  useEffect(() => {
    setCourseIdx(0);
  }, [route?.feedId, route?.rawId]);

  const metaLine = useLineMeta(route?.feedId ?? null, route?.rawId ?? null, stop?.rawId ?? null);

  if (!route) return null;

  const dirs = dirsState.status === 'ready' ? dirsState.value : [];
  const course = dirs.length > 0 ? dirs[Math.min(courseIdx, dirs.length - 1)] : null;
  const stops = course?.stops ?? [];
  const selectedStopId = stop?.rawId ?? null;

  const headline = metaLine
    ? metaLine.route_short_name || metaLine.route_long_name || route.rawId
    : route.rawId;
  const subLine = metaLine?.route_long_name && metaLine.route_short_name
    ? metaLine.route_long_name
    : '';

  return (
    <div className="inspector-card">
      <div className="inspector-card-head">
        <div className="inspector-card-kind">Line</div>
        <button
          type="button"
          className="inspector-card-close"
          onClick={() => setInspectorRoute(null)}
          title="Clear line selection"
          aria-label="Clear line selection"
        >
          ×
        </button>
      </div>

      <div className="inspector-card-title">{headline || '(unknown route)'}</div>
      {subLine && <div className="muted inspector-card-sub">{subLine}</div>}
      <div className="inspector-card-meta">
        {metaLine && (
          <>
            <ModeSwatch mode={metaLine.mode} size={12} />
            <span>{MODE_LABEL[metaLine.mode]}</span>
            {metaLine.agency_name && <span className="inspector-dot-sep">·</span>}
            {metaLine.agency_name && <span>{metaLine.agency_name}</span>}
          </>
        )}
      </div>
      <div className="muted inspector-card-sub" style={{ fontFamily: 'ui-monospace, monospace' }}>
        {route.rawId}
      </div>

      {route.canonicalId && registry && registry.routes[route.canonicalId] && (
        <div className="inspector-canonical">
          <div className="muted inspector-canonical-label">Canonical</div>
          <div className="inspector-canonical-id">{route.canonicalId}</div>
        </div>
      )}

      <InspectorSection
        title="Stops"
        count={stopsSectionCount(dirsState, stops.length)}
      >
        {dirsState.status === 'loading' && (
          <div className="muted inspector-placeholder">Loading stops…</div>
        )}
        {dirsState.status === 'error' && (
          <div className="muted inspector-placeholder" style={{ color: 'var(--removed)' }}>
            Failed to load stops: {dirsState.message}
          </div>
        )}
        {dirsState.status === 'ready' && dirs.length === 0 && (
          <div className="muted inspector-placeholder">No stops found for this line.</div>
        )}

        {dirsState.status === 'ready' && course && (
          <>
            <DirectionHeader
              course={course}
              courseIdx={Math.min(courseIdx, dirs.length - 1)}
              totalCourses={dirs.length}
              onToggle={() => setCourseIdx((i) => (i + 1) % dirs.length)}
            />
            <div className="stop-pill-list">
              {stops.map((s, i) => (
                <StopPill
                  key={`${s.stop_id}:${i}`}
                  stopId={s.stop_id}
                  stopName={s.stop_name}
                  seq={i + 1}
                  idTag={s.stop_id}
                  selected={s.stop_id === selectedStopId}
                  onClick={() =>
                    setInspectorStop({
                      feedId: route.feedId,
                      rawId: s.stop_id,
                      stopName: s.stop_name,
                      modes: [],
                      canonicalId: registry
                        ? registry.stopAssignments[`${route.feedId}\t${s.stop_id}`] ?? null
                        : null,
                    })
                  }
                />
              ))}
            </div>
          </>
        )}
      </InspectorSection>
    </div>
  );
}

function stopsSectionCount(
  state: ReturnType<typeof useRouteDirections>,
  shownLen: number,
): number | undefined {
  return state.status === 'ready' ? shownLen : undefined;
}

/**
 * Header row above the ordered stops list: direction pager + headsign +
 * "Other direction" button. Hidden when there's only one direction.
 */
function DirectionHeader({
  course,
  courseIdx,
  totalCourses,
  onToggle,
}: {
  course: { direction_id: number | null; headsign: string; trip_count: number; stops: { stop_id: string }[] };
  courseIdx: number;
  totalCourses: number;
  onToggle: () => void;
}) {
  return (
    <div className="route-course">
      <div className="route-course-head">
        <div>
          <div className="muted route-course-label">
            Course {courseIdx + 1} / {totalCourses}
            {course.direction_id != null && (
              <>
                {' '}
                · dir {course.direction_id}
              </>
            )}
          </div>
          <div className="route-course-headsign" title={course.headsign}>
            → {course.headsign || '(no headsign)'}
          </div>
          <div className="muted route-course-trips">
            ~{course.trip_count.toLocaleString()} trips in this pattern
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
  );
}

/**
 * Resolve enough metadata to label the route card (short name, long name,
 * agency, mode). We prefer a free ride on the stop's already-fetched line
 * list; otherwise we hit DuckDB once via `fetchLinesForStop` of the first
 * stop on the first direction's pattern. Null until resolved.
 */
function useLineMeta(
  feedId: string | null,
  routeId: string | null,
  preferFromStopId: string | null,
): LineForStop | null {
  const [meta, setMeta] = useState<LineForStop | null>(null);
  useEffect(() => {
    if (!feedId || !routeId) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    setMeta(null);
    (async () => {
      try {
        if (preferFromStopId) {
          const lines = await getLinesForStop(feedId, preferFromStopId);
          const hit = lines.find((l) => l.route_id === routeId);
          if (hit && !cancelled) {
            setMeta(hit);
            return;
          }
        }
        const dirs = await getRouteDirections(feedId, routeId);
        const firstStop = dirs[0]?.stops[0];
        if (!firstStop || cancelled) return;
        const lines = await getLinesForStop(feedId, firstStop.stop_id);
        const hit = lines.find((l) => l.route_id === routeId);
        if (hit && !cancelled) setMeta(hit);
      } catch (err) {
        console.warn('route meta lookup failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedId, routeId, preferFromStopId]);
  return meta;
}
