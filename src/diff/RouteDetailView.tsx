// Per-route detail view: a single MapLibre instance fit to the focused
// route's shapes, with a Colored / Old shape / New shape mode switch, plus
// the stop-diff markers and frequency overlay scoped to just this route
// (these moved out of the split overview to keep both of its map instances
// lightweight — see the plan's decision on stops/frequency scope).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import type { DiffedRun, DiffedShapes } from '../gtfs/segment-graph';
import { SEGMENT_COLOR, segmentDiffToGeoJSON } from '../gtfs/segment-graph';
import { DIFF_COLOR, STOP_LEGEND, diffStopPoints, diffStopGhosts, diffMoveArrows } from './geojson';
import { getOrComputeFrequencyDiff, frequencyDiffToGeoJSON, type FrequencyDiffResult } from './frequency';
import {
  createDiffMapStyle,
  addDiffFrequencyLayers,
  addDiffSegmentLayers,
  addDiffStopLayers,
  emptyFC,
  filterFeaturesNearRoute,
  setSource,
} from './diffMapLayers';

const STOP_ROUTE_TOL_M = 60;

const GEOM_LEGEND: Array<{ id: 'unchanged' | 'removed' | 'added' | 'changed'; label: string }> = [
  { id: 'unchanged', label: 'Unchanged' },
  { id: 'removed', label: 'Removed' },
  { id: 'added', label: 'Added' },
  { id: 'changed', label: 'Rerouted' },
];

const FREQUENCY_LEGEND: Array<{ id: string; label: string; color: string }> = [
  { id: 'down', label: 'Frequency decreased', color: '#ea580c' },
  { id: 'flat', label: 'Frequency unchanged', color: '#475569' },
  { id: 'up', label: 'Frequency increased', color: '#2563eb' },
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
  const diffDetailMode = useAppStore((s) => s.diffDetailMode) as DetailMode;
  const setDiffDetailMode = useAppStore((s) => s.setDiffDetailMode);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const toggleDiffStopLabels = useAppStore((s) => s.toggleDiffStopLabels);
  const diffOverlay = useAppStore((s) => s.diffOverlay);
  const setDiffOverlay = useAppStore((s) => s.setDiffOverlay);

  const diffStatus = useDiff(activeFeedId, compareFeedId);
  const entry = diffStatus.kind === 'ready'
    ? diffStatus.result.routes.find((r) => r.canonicalId === diffRouteFocus) ?? null
    : null;

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
    return diffedShapes.runs.filter((r) => r.canonicalId === diffRouteFocus);
  }, [diffedShapes, diffRouteFocus]);

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

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createDiffMapStyle(),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      addDiffSegmentLayers(map);
      // Focused line mode: names show at any zoom (map is scoped to one line).
      addDiffStopLayers(map, { labelMinZoom: 0 });
      addDiffFrequencyLayers(map);
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

  // Re-fit if the focused route changes while this view stays mounted (e.g.
  // switching to a sibling candidate via the inspector), not just on mount.
  const prevFocusRef = useRef(diffRouteFocus);
  useEffect(() => {
    if (!ready || prevFocusRef.current === diffRouteFocus) return;
    prevFocusRef.current = diffRouteFocus;
    fitToRoute();
  }, [diffRouteFocus, ready, fitToRoute]);

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
    if (!diffedShapes || !diffRouteFocus || diffOverlay !== 'geometry') {
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
      if (diffDetailMode === 'old') return r.feed === 'a';
      if (diffDetailMode === 'new') return r.feed === 'b';
      // 'colored' keeps *both* unchanged copies. They trace the same street
      // and overdraw each other, but each feed's runs are splits of that
      // feed's own polyline: the A-side unchanged run starts exactly where
      // the A-side `changed`/'old' run ends, and likewise for B. Keeping only
      // one side leaves the other side's rerouted piece ending in mid-air —
      // its continuation was the copy that got dropped, and the surviving
      // copy starts at the equivalent point on the *other* polyline, up to
      // TOL_M (25m) away. Drawing both yields two continuous chains.
      // Only affordable because this view is scoped to a single route; the
      // network/split views keep `preferFeed('a')`.
      return true;
    };
    const visibility = { unchanged: true, added: true, removed: true, changed: true };
    const { features } = segmentDiffToGeoJSON(diffedShapes, visibility, accept);
    setSource(map, 'diff-segments', features);
  }, [diffedShapes, diffRouteFocus, diffDetailMode, diffOverlay, ready]);

  // Frequency overlay, scoped to this route — only populated in 'frequency' mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!frequency || !diffRouteFocus || diffOverlay !== 'frequency') {
      setSource(map, 'diff-frequency', emptyFC());
      return;
    }
    const fc = frequencyDiffToGeoJSON(frequency);
    const routeOnly: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: fc.features.filter((f) => f.properties?.canonicalId === diffRouteFocus),
    };
    setSource(map, 'diff-frequency', routeOnly);
  }, [frequency, diffRouteFocus, diffOverlay, ready]);

  // Stop-diff, scoped to this route's stops. Stop entries don't carry a
  // route id, so "this route's stops" is approximated geometrically —
  // anything within STOP_ROUTE_TOL_M of the route's own shape runs.
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
    setSource(map, 'diff-stops', filterFeaturesNearRoute(
      diffStopPoints(diffStatus.result, diffStopVisibility), routeRuns, STOP_ROUTE_TOL_M,
    ));
    setSource(map, 'diff-ghost', filterFeaturesNearRoute(
      diffStopGhosts(diffStatus.result, diffStopVisibility), routeRuns, STOP_ROUTE_TOL_M,
    ));
    setSource(map, 'diff-arrow', filterFeaturesNearRoute(
      diffMoveArrows(diffStatus.result, diffStopVisibility), routeRuns, STOP_ROUTE_TOL_M,
    ));
  }, [diffStatus, diffRouteFocus, diffStopVisibility, routeRuns, ready]);

  // Station-name labels on/off.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('diff-stops-labels')) return;
    map.setLayoutProperty('diff-stops-labels', 'visibility', diffStopLabels ? 'visible' : 'none');
  }, [diffStopLabels, ready]);

  if (!entry) return null;

  const label = entry.canonical.shortName || entry.canonical.longName || diffRouteFocus;

  return (
    <div className="route-detail-view">
      <div className="route-detail-header">
        <button
          type="button"
          className="route-detail-back"
          onClick={() => setDiffRouteFocus(null)}
        >
          ← Back
        </button>
        <span className="route-detail-title">{label}</span>
        <div className="route-detail-mode-switch">
          {(['geometry', 'frequency'] as const).map((overlay) => (
            <button
              key={overlay}
              type="button"
              className={diffOverlay === overlay ? 'on' : 'off'}
              onClick={() => setDiffOverlay(overlay)}
            >
              {overlay === 'geometry' ? 'Geometry' : 'Frequency'}
            </button>
          ))}
        </div>
        {diffOverlay === 'geometry' && (
          <div className="route-detail-mode-switch">
            {(['colored', 'old', 'new'] as DetailMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={diffDetailMode === mode ? 'on' : 'off'}
                onClick={() => setDiffDetailMode(mode)}
              >
                {mode === 'colored' ? 'Colored' : mode === 'old' ? 'Old shape' : 'New shape'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="route-detail-map">
        <div ref={containerRef} className="route-detail-map-canvas" />
        <div className="map-mode-legend route-detail-legend">
          {diffOverlay === 'geometry'
            ? GEOM_LEGEND.map(({ id, label: legendLabel }) => (
                <span key={id} className="diff-count on" style={{ pointerEvents: 'none' }}>
                  <span className="diff-count-swatch diff-count-swatch--line" style={{ background: SEGMENT_COLOR[id] }} />
                  <span className="diff-count-label">{legendLabel}</span>
                </span>
              ))
            : FREQUENCY_LEGEND.map(({ id, label: legendLabel, color }) => (
                <span key={id} className="diff-count on" style={{ pointerEvents: 'none' }}>
                  <span className="diff-count-swatch diff-count-swatch--line" style={{ background: color }} />
                  <span className="diff-count-label">{legendLabel}</span>
                </span>
              ))}
          {STOP_LEGEND.map(({ id, label: legendLabel }) => (
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
          <label className={`diff-count ${diffStopLabels ? 'on' : 'off'}`}>
            <input type="checkbox" checked={diffStopLabels} onChange={toggleDiffStopLabels} />
            <span className="diff-count-swatch diff-count-swatch--label">A</span>
            <span className="diff-count-label">Station names</span>
          </label>
        </div>
      </div>
    </div>
  );
}
