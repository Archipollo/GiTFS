// Per-route detail view: a single MapLibre instance fit to the focused
// route's shapes, with a Colored / Old shape / New shape mode switch, plus
// the stop-diff markers scoped to just this route. The frequency overlay
// (toggled globally via the Analysis menu, `analysisMode`) is network-wide,
// same as the network/split overview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import { useLineDirections } from './useLineDirections';
import type { DiffedRun, DiffedShapes } from '../gtfs/segment-graph';
import { SEGMENT_COLOR, segmentDiffToGeoJSON, buildRunLineStatus } from '../gtfs/segment-graph';
import {
  DIFF_COLOR,
  STOP_LEGEND,
  diffStopPoints,
  diffStopPointsForFeed,
  diffStopGhosts,
  diffMoveArrows,
  filterStopsByRouteMembership,
} from './geojson';
import { getOrComputeFrequencyDiff, frequencyDiffToGeoJSON, filterFrequencyDiff, type FrequencyDiffResult } from './frequency';
import { FrequencyLegend } from './FrequencyLegend';
import {
  createDiffMapStyle,
  addDiffFrequencyLayers,
  addDiffSegmentLayers,
  addDiffStopLayers,
  attachDiffFrequencyClickHandler,
  attachDiffStopClickHandler,
  setDiffRouteHighlight,
  setDiffStopHighlight,
  emptyFC,
  filterFeaturesNearRoute,
  setSource,
  ALL_SEGMENT_STATUSES_VISIBLE,
  ALL_STOP_STATUSES_VISIBLE,
} from './diffMapLayers';
import { usePersistedCamera } from '../map/usePersistedCamera';

const STOP_ROUTE_TOL_M = 60;

const GEOM_LEGEND: Array<{ id: 'unchanged' | 'removed' | 'added' | 'changed'; label: string }> = [
  { id: 'unchanged', label: 'Unchanged' },
  { id: 'removed', label: 'Removed' },
  { id: 'added', label: 'Added' },
  { id: 'changed', label: 'Rerouted' },
];

const INITIAL_CENTER: [number, number] = [14.55, 47.6];
const INITIAL_ZOOM = 6.5;

type DetailMode = 'colored' | 'old' | 'new';

function boundsOfCoords(coordsList: [number, number][][]): maplibregl.LngLatBoundsLike | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let any = false;
  for (const coords of coordsList) {
    for (const [lon, lat] of coords) {
      any = true;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return any ? [[minLon, minLat], [maxLon, maxLat]] : null;
}

export function RouteDetailView({ diffedShapes }: { diffedShapes: DiffedShapes | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffStopFocus = useAppStore((s) => s.setDiffStopFocus);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const diffDetailMode = useAppStore((s) => s.diffDetailMode) as DetailMode;
  const setDiffDetailMode = useAppStore((s) => s.setDiffDetailMode);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const toggleDiffStopLabels = useAppStore((s) => s.toggleDiffStopLabels);
  const analysisMode = useAppStore((s) => s.analysisMode);
  const frequencyIncludeAddedRemoved = useAppStore((s) => s.frequencyIncludeAddedRemoved);
  const diffDirectionFocus = useAppStore((s) => s.diffDirectionFocus);
  const setDiffDirectionFocus = useAppStore((s) => s.setDiffDirectionFocus);
  const diffRouteDirections = useAppStore((s) => s.diffRouteDirections);

  const diffStatus = useDiff(activeFeedId, compareFeedId);
  const entry = diffStatus.kind === 'ready'
    ? diffStatus.result.routes.find((r) => r.canonicalId === diffRouteFocus) ?? null
    : null;

  // direction_ids of this route whose geometry can actually be isolated on the
  // map, plus their headsigns; empty ⇒ the line only shows as "Entire line".
  const isolableDirections = (diffRouteFocus && diffRouteDirections?.get(diffRouteFocus)) || [];
  // Always enabled (not just when directions are isolable): `stopIdsByDirection`
  // also drives stop-diff filtering for "Entire line" mode, where it's unioned
  // across all directions.
  const { headsigns, stopIdsByDirection } = useLineDirections(entry, activeFeedId, compareFeedId, !!entry);

  // Actual `stop_id`s this route+direction serves, per feed — lets the stop-diff
  // filter tell apart same-named-but-different physical stops (e.g. several
  // stop_ids sharing a name at an intersection, only some of which this line's
  // representative pattern actually visits) instead of relying on proximity to
  // the route's shape alone, which can't distinguish nearby unrelated stops.
  const routeStopIds = useMemo(() => {
    if (diffDirectionFocus != null) {
      return stopIdsByDirection.get(diffDirectionFocus) ?? { a: new Set<string>(), b: new Set<string>() };
    }
    const a = new Set<string>();
    const b = new Set<string>();
    for (const bucket of stopIdsByDirection.values()) {
      for (const id of bucket.a) a.add(id);
      for (const id of bucket.b) b.add(id);
    }
    return { a, b };
  }, [stopIdsByDirection, diffDirectionFocus]);

  const runLineStatus = useMemo(
    () => (diffStatus.kind === 'ready' ? buildRunLineStatus(diffStatus.result.routes) : undefined),
    [diffStatus],
  );

  const [frequency, setFrequency] = useState<FrequencyDiffResult | null>(null);
  useEffect(() => {
    if (diffStatus.kind !== 'ready') { setFrequency(null); return; }
    let cancelled = false;
    getOrComputeFrequencyDiff(diffStatus.result)
      .then((r) => { if (!cancelled) setFrequency(r); })
      .catch((err) => console.warn('detail frequency compute failed', err));
    return () => { cancelled = true; };
  }, [diffStatus]);

  const routeRuns = useMemo(() => {
    if (!diffedShapes || !diffRouteFocus) return [];
    return diffedShapes.runs.filter(
      (r) =>
        r.canonicalId === diffRouteFocus &&
        (diffDirectionFocus == null || r.direction_id === diffDirectionFocus),
    );
  }, [diffedShapes, diffRouteFocus, diffDirectionFocus]);

  // Runs the stop overlay should snap to, scoped to the mode's feed. 'old'
  // filters near the old alignment, 'new' near the new one; 'colored' keeps
  // both so cross-feed diff stops (moved/renamed) stay in view.
  const modeRuns = useMemo(() => {
    if (diffDetailMode === 'old') return routeRuns.filter((r) => r.feed === 'a');
    if (diffDetailMode === 'new') return routeRuns.filter((r) => r.feed === 'b');
    return routeRuns;
  }, [routeRuns, diffDetailMode]);

  // Read via a ref (not the `ready` React-state effect graph) so the initial
  // fit-to-route can run directly from the map's own 'load' callback instead
  // of depending on effect-ordering between the `ready` flip and a separate
  // routeRuns-dependent effect — that ordering dependency was the bug: the
  // fit sometimes never fired on first mount even though "Show full line"
  // (which calls this same helper) always worked.
  const routeRunsRef = useRef(routeRuns);
  useEffect(() => {
    routeRunsRef.current = routeRuns;
  }, [routeRuns]);

  const fitToRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = boundsOfCoords(routeRunsRef.current.map((r) => r.coords));
    if (bounds) map.fitBounds(bounds, { padding: 60, duration: 500, maxZoom: 15 });
  }, []);

  // Detail always fits to the focused route, so it reads the overview camera
  // only to start that animation from a nearby view (save=false) — drilling
  // into a route must never overwrite the camera the overview restores to.
  const initialCamera = usePersistedCamera(mapRef, ready, false);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createDiffMapStyle(),
      center: initialCamera?.center ?? INITIAL_CENTER,
      zoom: initialCamera?.zoom ?? INITIAL_ZOOM,
      bearing: initialCamera?.bearing ?? 0,
      pitch: initialCamera?.pitch ?? 0,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      addDiffSegmentLayers(map);
      // Focused line mode: names show at any zoom (map is scoped to one line).
      addDiffStopLayers(map, { labelMinZoom: 0 });
      addDiffFrequencyLayers(map);
      // Frequency here is network-wide (see the comment above), so clicking a
      // different line while it's active should re-focus the inspector onto
      // that line rather than being a no-op.
      attachDiffFrequencyClickHandler(map, setDiffRouteFocus);
      attachDiffStopClickHandler(map, setDiffStopFocus);
      fitToRoute();
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit if the focused route *or direction* changes while this view stays
  // mounted (e.g. switching to a sibling candidate via the inspector, or
  // picking a direction), not just on mount.
  const prevFocusRef = useRef(`${diffRouteFocus}\t${diffDirectionFocus}`);
  useEffect(() => {
    const key = `${diffRouteFocus}\t${diffDirectionFocus}`;
    if (!ready || prevFocusRef.current === key) return;
    prevFocusRef.current = key;
    fitToRoute();
  }, [diffRouteFocus, diffDirectionFocus, ready, fitToRoute]);

  // Explicit re-fit, requested via the inspector's "Show full line" button.
  const diffRouteZoomToken = useAppStore((s) => s.diffRouteZoomToken);
  const isInitialZoomToken = useRef(true);
  useEffect(() => {
    if (isInitialZoomToken.current) { isInitialZoomToken.current = false; return; }
    if (!ready) return;
    fitToRoute();
  }, [diffRouteZoomToken, ready, fitToRoute]);

  // Segment geometry, filtered by mode switch. Geometry-status colors and
  // the frequency overlay are mutually exclusive (both trace the same
  // shape data with unrelated color scales — showing both at once is what
  // produced the unexplained "blue line" bug), so this layer goes empty
  // whenever the frequency overlay is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffedShapes || !diffRouteFocus || analysisMode === 'frequency') {
      setSource(map, 'diff-segments', emptyFC());
      return;
    }
    // 'old'/'new' show one feed's own polyline. `unchanged` exists as a
    // separate copy per feed for the same corridor, so each mode takes the
    // copy belonging to the side it is showing — otherwise the shared
    // stretches drop out and the route renders as disconnected fragments
    // with the rerouted piece floating unattached.
    const accept = (r: DiffedRun) => {
      if (r.canonicalId !== diffRouteFocus) return false;
      // Isolate one direction when focused (union/null runs drop out).
      if (diffDirectionFocus != null && r.direction_id !== diffDirectionFocus) return false;
      if (diffDetailMode === 'old') return r.feed === 'a';
      if (diffDetailMode === 'new') return r.feed === 'b';
      // 'colored' = the *new status quo* with changes highlighted: draw the
      // new feed's (B) `unchanged` corridor as the base plus every change
      // (removed/added/changed, either feed) on top. We deliberately drop the
      // OLD feed's (A) `unchanged` copy — it traces the same street within
      // TOL_M (25m) of B's, so drawing it just paints a parallel "ghost" of
      // geometry that isn't there anymore (e.g. a <25m detour reads as a
      // second grey line beside the new one, looking like a spurious loop).
      // A reroute's old-side piece can now end up to TOL_M from where B's
      // unchanged copy picks up, but that ≤25m gap sits right on the new
      // corridor and reads as the change bulging off it — the intended story
      // — rather than as duplicated grey.
      return r.status !== 'unchanged' || r.feed === 'b';
    };
    const visibility = { unchanged: true, added: true, removed: true, changed: true };
    const { features } = segmentDiffToGeoJSON(diffedShapes, visibility, accept, runLineStatus);
    // 'old'/'new' are a single-feed *snapshot*, not a diff: rewrite each run's
    // status props so the whole polyline renders through the neutral
    // `unchanged` line layer instead of the red/green/yellow-dotted reroute
    // layers (which key on geom_status / changed_side / line_status). Colored
    // keeps its real diff statuses.
    if (diffDetailMode !== 'colored') {
      for (const f of features.features) {
        if (!f.properties) continue;
        f.properties.geom_status = 'unchanged';
        f.properties.changed_side = null;
        f.properties.line_status = 'none';
      }
    }
    setSource(map, 'diff-segments', features);
  }, [diffedShapes, diffRouteFocus, diffDirectionFocus, diffDetailMode, analysisMode, runLineStatus, ready]);

  // Always-on geometry backing the focused route's glow — every status, both
  // feeds, unfiltered by direction/mode — used only in frequency mode (see
  // below): that's the one case where the network-wide frequency overlay
  // draws other routes too, so a glow around this one is actually useful;
  // in geometry mode the map already shows nothing but this route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffedShapes || !diffRouteFocus) { setSource(map, 'diff-segments-focus-data', emptyFC()); return; }
    const { features } = segmentDiffToGeoJSON(
      diffedShapes,
      ALL_SEGMENT_STATUSES_VISIBLE,
      (r) => r.canonicalId === diffRouteFocus,
      runLineStatus,
    );
    setSource(map, 'diff-segments-focus-data', features);
  }, [diffedShapes, diffRouteFocus, runLineStatus, ready]);

  // Frequency overlay — network-wide (not scoped to just this route), same
  // data path as the network/split overview so panning out shows the full
  // picture instead of just the focused line's delta.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!frequency || analysisMode !== 'frequency') {
      setSource(map, 'diff-frequency', emptyFC());
      return;
    }
    setSource(map, 'diff-frequency', frequencyDiffToGeoJSON(filterFrequencyDiff(frequency, frequencyIncludeAddedRemoved)));
  }, [frequency, analysisMode, ready, frequencyIncludeAddedRemoved]);

  // Stop-diff, scoped to this route's stops. Stop entries don't carry a route
  // id, so membership is narrowed two ways: first to the actual `stop_id`s
  // the route+direction's representative pattern visits (`routeStopIds`,
  // real GTFS identity — tells apart same-named stops at an intersection),
  // then to anything within STOP_ROUTE_TOL_M of the route's own shape runs
  // (geometric fallback, still needed since the representative pattern can
  // miss a legitimate stop_id used only by a minority trip pattern).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || diffStatus.kind !== 'ready' || !diffRouteFocus) {
      if (map) {
        setSource(map, 'diff-stops', emptyFC());
        setSource(map, 'diff-ghost', emptyFC());
        setSource(map, 'diff-arrow', emptyFC());
      }
      return;
    }
    const scoped = filterStopsByRouteMembership(diffStatus.result, routeStopIds);
    // 'old'/'new' show one feed's own stops at that feed's positions (added
    // never appears in 'old', removed never in 'new' — diffStopPointsForFeed
    // drops the side that doesn't exist), and no ghost/arrow move markers,
    // since a snapshot has no before→after to draw. 'colored' keeps the full
    // cross-feed diff with ghosts + arrows.
    const points = diffDetailMode === 'colored'
      ? diffStopPoints(scoped, diffStopVisibility)
      : diffStopPointsForFeed(scoped, diffStopVisibility, diffDetailMode === 'old' ? 'a' : 'b');
    setSource(map, 'diff-stops', filterFeaturesNearRoute(points, modeRuns, STOP_ROUTE_TOL_M));
    setSource(map, 'diff-ghost', diffDetailMode === 'colored'
      ? filterFeaturesNearRoute(diffStopGhosts(scoped, diffStopVisibility), modeRuns, STOP_ROUTE_TOL_M)
      : emptyFC());
    setSource(map, 'diff-arrow', diffDetailMode === 'colored'
      ? filterFeaturesNearRoute(diffMoveArrows(scoped, diffStopVisibility), modeRuns, STOP_ROUTE_TOL_M)
      : emptyFC());
  }, [diffStatus, diffRouteFocus, diffStopVisibility, diffDetailMode, modeRuns, routeStopIds, ready]);

  // Always-on stop points backing the focused stop's halo — every status,
  // unfiltered by the checkboxes (frequency mode zeroes them all), so the
  // halo survives switching into analysis view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (diffStatus.kind !== 'ready') { setSource(map, 'diff-stops-focus-data', emptyFC()); return; }
    setSource(map, 'diff-stops-focus-data', diffStopPoints(diffStatus.result, ALL_STOP_STATUSES_VISIBLE));
  }, [diffStatus, ready]);

  // Station-name labels on/off.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('diff-stops-labels')) return;
    map.setLayoutProperty('diff-stops-labels', 'visibility', diffStopLabels ? 'visible' : 'none');
  }, [diffStopLabels, ready]);

  // Violet halo on the inspector-focused stop.
  useEffect(() => {
    if (mapRef.current && ready) setDiffStopHighlight(mapRef.current, diffStopFocus);
  }, [diffStopFocus, ready]);

  // Route glow, only in frequency mode: the network-wide frequency overlay
  // draws every route, so highlighting this one helps it stand out. In
  // geometry mode the map already shows nothing but this route, so a glow
  // around it would just tint everything for no benefit.
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    setDiffRouteHighlight(mapRef.current, analysisMode === 'frequency' ? diffRouteFocus : null);
  }, [diffRouteFocus, analysisMode, ready]);

  if (!entry) return null;

  const label = entry.canonical.shortName || entry.canonical.longName || diffRouteFocus;

  return (
    <div className="route-detail-view">
      <div className="route-detail-header">
        <div className="route-detail-header-side route-detail-header-left">
          <button
            type="button"
            className="route-detail-back"
            onClick={() => setDiffRouteFocus(null)}
          >
            ← Back
          </button>
          <span className="route-detail-title">
            {label}
            <span className="route-detail-subtitle">
              {diffDirectionFocus == null
                ? 'Entire line'
                : headsigns.get(diffDirectionFocus)
                  ? `→ ${headsigns.get(diffDirectionFocus)}`
                  : `Direction ${diffDirectionFocus}`}
            </span>
          </span>
        </div>
        {isolableDirections.length > 0 && (
          <div className="route-detail-mode-switch route-detail-dir-switch">
            <button
              type="button"
              className={diffDirectionFocus == null ? 'on' : 'off'}
              onClick={() => setDiffDirectionFocus(null)}
            >
              Entire line
            </button>
            {isolableDirections.map((id) => (
              <button
                key={id}
                type="button"
                className={diffDirectionFocus === id ? 'on' : 'off'}
                title={headsigns.get(id) || `Direction ${id}`}
                onClick={() => setDiffDirectionFocus(id)}
              >
                {headsigns.get(id) ? `→ ${headsigns.get(id)}` : `Dir ${id}`}
              </button>
            ))}
          </div>
        )}
        <div className="route-detail-header-side route-detail-header-right">
          {analysisMode !== 'frequency' && (
            <div className="route-detail-mode-switch">
              {(['colored', 'old', 'new'] as DetailMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={diffDetailMode === mode ? 'on' : 'off'}
                  onClick={() => setDiffDetailMode(mode)}
                >
                  {mode === 'colored' ? 'Entire shape' : mode === 'old' ? 'Old shape' : 'New shape'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="route-detail-map">
        <div ref={containerRef} className="route-detail-map-canvas" />
        <div className="map-mode-legend route-detail-legend">
          {analysisMode === 'frequency'
            ? <FrequencyLegend />
            : diffDetailMode === 'colored'
              ? GEOM_LEGEND.map(({ id, label: legendLabel }) => (
                  <span key={id} className="diff-count on" style={{ pointerEvents: 'none' }}>
                    <span className="diff-count-swatch diff-count-swatch--line" style={{ background: SEGMENT_COLOR[id] }} />
                    <span className="diff-count-label">{legendLabel}</span>
                  </span>
                ))
              : (
                  <span className="diff-count on" style={{ pointerEvents: 'none' }}>
                    <span className="diff-count-swatch diff-count-swatch--line" style={{ background: SEGMENT_COLOR.unchanged }} />
                    <span className="diff-count-label">{diffDetailMode === 'old' ? 'Old route' : 'New route'}</span>
                  </span>
                )}
          {analysisMode !== 'frequency' && STOP_LEGEND.map(({ id, label: legendLabel }) => (
            <label key={id} className={`diff-count ${diffStopVisibility[id] ? 'on' : 'off'}`}>
              <input
                type="checkbox"
                checked={diffStopVisibility[id]}
                onChange={() => toggleDiffStopVisibility(id)}
              />
              <span className="diff-count-swatch" style={{ background: DIFF_COLOR[id] }} />
              <span className="diff-count-label">{legendLabel}</span>
            </label>
          ))}
          {analysisMode !== 'frequency' && (
            <label className={`diff-count ${diffStopLabels ? 'on' : 'off'}`}>
              <input type="checkbox" checked={diffStopLabels} onChange={toggleDiffStopLabels} />
              <span className="diff-count-swatch diff-count-swatch--label">A</span>
              <span className="diff-count-label">Station names</span>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
