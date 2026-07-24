// Single-map diff overview: the whole network on one map, all statuses
// (added/removed/rerouted/unchanged) visible simultaneously. This is the
// default diff-mode overview; SplitMapView (old feed / new feed side by
// side) is an opt-in alternative toggled from the top bar. Unlike the two
// SplitMapView panes, this single map also shows the stop-diff dots
// (added/removed/moved/renamed, unchanged hidden by default) — one map
// instance keeps the cost low enough that the "geometry-only" scope that
// still applies to split view isn't needed here.

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import type { DiffedShapes, GeomStatus } from '../gtfs/segment-graph';
import { SEGMENT_COLOR, segmentDiffToGeoJSON, preferFeedKeepingReroutes, buildRunLineStatus } from '../gtfs/segment-graph';
import { DIFF_COLOR, STOP_LEGEND, diffStopPoints, diffStopGhosts, diffMoveArrows } from './geojson';
import { useDiff } from './useDiff';
import { getOrComputeFrequencyDiff, frequencyDiffToGeoJSON, filterFrequencyDiff, type FrequencyDiffResult } from './frequency';
import { FrequencyLegend } from './FrequencyLegend';
import { yearOfFeed } from '../timeline/math';
import { BasemapControls } from '../map/BasemapControls';
import { useBasemap } from '../map/basemap';
import { usePersistedCamera } from '../map/usePersistedCamera';
import {
  createDiffMapStyle,
  FIRST_DIFF_LAYER_ID,
  addDiffSegmentLayers,
  addDiffStopLayers,
  addDiffFrequencyLayers,
  attachDiffSegmentClickHandler,
  attachDiffFrequencyClickHandler,
  attachDiffStopClickHandler,
  setDiffRouteHighlight,
  setDiffStopHighlight,
  boundsOfLineFeatures,
  emptyFC,
  setSource,
  ALL_SEGMENT_STATUSES_VISIBLE,
  ALL_STOP_STATUSES_VISIBLE,
} from './diffMapLayers';

const INITIAL_CENTER: [number, number] = [14.55, 47.6];
const INITIAL_ZOOM = 6.5;

export function NetworkDiffMapView({ diffedShapes }: { diffedShapes: DiffedShapes | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const toggleDiffSegmentVisibility = useAppStore((s) => s.toggleDiffSegmentVisibility);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const toggleDiffStopLabels = useAppStore((s) => s.toggleDiffStopLabels);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffStopFocus = useAppStore((s) => s.setDiffStopFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const diffDirectionFocus = useAppStore((s) => s.diffDirectionFocus);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const analysisMode = useAppStore((s) => s.analysisMode);
  const setDiffFrequencySummary = useAppStore((s) => s.setDiffFrequencySummary);
  const frequencyIncludeAddedRemoved = useAppStore((s) => s.frequencyIncludeAddedRemoved);
  // Stop-diff shares the same cached (A,B) result the detail view already
  // computed — `useDiff` hits `peekDiff`, so this second caller adds no worker
  // work for a pair that's already been diffed.
  const diffStatus = useDiff(activeFeedId, compareFeedId);

  // Frequency overlay data — same cached (A,B) computation RouteDetailView
  // uses, network-wide (no per-route filtering).
  const [frequency, setFrequency] = useState<FrequencyDiffResult | null>(null);
  useEffect(() => {
    if (diffStatus.kind !== 'ready') { setFrequency(null); return; }
    let cancelled = false;
    getOrComputeFrequencyDiff(diffStatus.result)
      .then((r) => { if (!cancelled) setFrequency(r); })
      .catch((err) => console.warn('network frequency compute failed', err));
    return () => { cancelled = true; };
  }, [diffStatus]);
  // Route-identity projection so removed/added geometry on a *surviving* line
  // renders as a reroute (yellow) rather than a line removal/addition.
  const runLineStatus = useMemo(
    () => (diffStatus.kind === 'ready' ? buildRunLineStatus(diffStatus.result.routes) : undefined),
    [diffStatus],
  );
  // Auto-fit once per feed pair — re-armed whenever `diffedShapes` swaps in a
  // new pair (see the effect below), so switching A/B refits the camera.
  const fittedForRef = useRef<DiffedShapes | null>(null);
  // When we restore a persisted camera (a layout switch, not a fresh session),
  // adopt the first rendered pair as already-fitted so the restore isn't
  // clobbered — while still letting a later A/B swap refit (identity changes).
  const skipInitialFitRef = useRef(!!useAppStore.getState().mapCamera);

  const initialCamera = usePersistedCamera(mapRef, ready);

  // Satellite era follows the basemap-year slider (DiffTimelineStrip), falling
  // back to feed A's year — the same default the slider itself starts from.
  const diffBasemapYear = useAppStore((s) => s.diffBasemapYear);
  const feedAYear = useAppStore((s) => {
    const meta = diffedShapes ? s.feeds[diffedShapes.feedA] : null;
    return meta ? yearOfFeed(meta).year : null;
  });
  useBasemap(mapRef, ready, diffBasemapYear ?? feedAYear, FIRST_DIFF_LAYER_ID);

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
      // Network overview: labels only once the user zooms into an area.
      addDiffStopLayers(map, { labelMinZoom: 12 });
      addDiffFrequencyLayers(map);
      attachDiffSegmentClickHandler(map, setDiffRouteFocus);
      attachDiffFrequencyClickHandler(map, setDiffRouteFocus);
      attachDiffStopClickHandler(map, setDiffStopFocus);
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffedShapes) {
      setSource(map, 'diff-segments', emptyFC());
      return;
    }
    const { features } = segmentDiffToGeoJSON(
      diffedShapes,
      diffSegmentVisibility,
      preferFeedKeepingReroutes(diffedShapes),
      runLineStatus,
    );
    // Geometry-status and frequency are mutually exclusive overlays (both
    // trace the same shape data), so this layer goes empty while frequency
    // is active — same rule RouteDetailView follows.
    setSource(map, 'diff-segments', analysisMode === 'frequency' ? emptyFC() : features);

    // Adopt the restored camera's pair as already-fitted (once), so a layout
    // switch keeps the user's view instead of snapping back to the extent.
    if (skipInitialFitRef.current) {
      fittedForRef.current = diffedShapes;
      skipInitialFitRef.current = false;
    }
    if (fittedForRef.current !== diffedShapes) {
      const bounds = boundsOfLineFeatures(features);
      if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 13 });
      fittedForRef.current = diffedShapes;
    }
  }, [diffedShapes, diffSegmentVisibility, runLineStatus, analysisMode, ready]);

  // Always-on geometry backing the inspector-focused route's glow — every
  // status, unfiltered by the status checkboxes, and never emptied when
  // frequency mode is active (unlike `diff-segments` above) so the glow
  // survives switching into analysis view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffedShapes) { setSource(map, 'diff-segments-focus-data', emptyFC()); return; }
    const { features } = segmentDiffToGeoJSON(
      diffedShapes,
      ALL_SEGMENT_STATUSES_VISIBLE,
      preferFeedKeepingReroutes(diffedShapes),
      runLineStatus,
    );
    setSource(map, 'diff-segments-focus-data', features);
  }, [diffedShapes, runLineStatus, ready]);

  // Frequency overlay for the whole network — unlike RouteDetailView this was
  // previously unavailable here at all; it's the same cached diff, just drawn
  // unfiltered instead of scoped to one focused route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!frequency || analysisMode !== 'frequency') {
      setSource(map, 'diff-frequency', emptyFC());
      return;
    }
    const filtered = filterFrequencyDiff(frequency, frequencyIncludeAddedRemoved);
    setSource(map, 'diff-frequency', frequencyDiffToGeoJSON(filtered));
    setDiffFrequencySummary({
      feedA: filtered.feedA,
      feedB: filtered.feedB,
      maxAbsDelta: filtered.maxAbsDelta,
      scaleAbsDelta: filtered.scaleAbsDelta,
      routeCount: filtered.entries.length,
    });
  }, [frequency, analysisMode, ready, frequencyIncludeAddedRemoved, setDiffFrequencySummary]);

  // Stop-diff dots for the whole network. Unlike RouteDetailView these aren't
  // filtered to a single route — every changed stop is shown. `unchanged` is
  // off by default (see the store) so this stays a sparse changed-only overlay.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (diffStatus.kind !== 'ready') {
      setSource(map, 'diff-stops', emptyFC());
      setSource(map, 'diff-ghost', emptyFC());
      setSource(map, 'diff-arrow', emptyFC());
      return;
    }
    setSource(map, 'diff-stops', diffStopPoints(diffStatus.result, diffStopVisibility));
    setSource(map, 'diff-ghost', diffStopGhosts(diffStatus.result, diffStopVisibility));
    setSource(map, 'diff-arrow', diffMoveArrows(diffStatus.result, diffStopVisibility));
  }, [diffStatus, diffStopVisibility, ready]);

  // Always-on stop points backing the inspector-focused stop's halo — every
  // status, unfiltered by the status checkboxes (which frequency mode zeroes
  // out entirely), so the halo survives switching into analysis view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (diffStatus.kind !== 'ready') { setSource(map, 'diff-stops-focus-data', emptyFC()); return; }
    setSource(map, 'diff-stops-focus-data', diffStopPoints(diffStatus.result, ALL_STOP_STATUSES_VISIBLE));
  }, [diffStatus, ready]);

  // Station-name labels on/off (zoom gating is handled by the layer's minzoom).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('diff-stops-labels')) return;
    map.setLayoutProperty('diff-stops-labels', 'visibility', diffStopLabels ? 'visible' : 'none');
  }, [diffStopLabels, ready]);

  // Violet halo on the inspector-focused line/stop.
  useEffect(() => {
    if (mapRef.current && ready) setDiffRouteHighlight(mapRef.current, diffRouteFocus, diffDirectionFocus);
  }, [diffRouteFocus, diffDirectionFocus, ready]);
  useEffect(() => {
    if (mapRef.current && ready) setDiffStopHighlight(mapRef.current, diffStopFocus);
  }, [diffStopFocus, ready]);

  // Explicit re-fit to the focused line's full extent, requested via the
  // inspector's "Show full line" button — this overview never otherwise fits
  // to a single route (only to the whole network on load/A-B swap), so
  // without this the button did nothing here. In frequency mode the segment
  // layer is emptied (see above), so the frequency overlay's own geometry
  // (now covering every shape variant of the route, not just its busiest one)
  // is used instead when a matching entry exists.
  const diffRouteZoomToken = useAppStore((s) => s.diffRouteZoomToken);
  const isInitialZoomToken = useRef(true);
  useEffect(() => {
    if (isInitialZoomToken.current) { isInitialZoomToken.current = false; return; }
    const map = mapRef.current;
    if (!map || !ready || !diffRouteFocus) return;

    let bounds: maplibregl.LngLatBoundsLike | null = null;
    if (analysisMode === 'frequency' && frequency) {
      const entry = frequency.entries.find((e) => e.canonicalId === diffRouteFocus);
      if (entry?.coords) {
        bounds = boundsOfLineFeatures({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: entry.coords }, properties: {} }],
        });
      }
    }
    if (!bounds && diffedShapes) {
      const { features } = segmentDiffToGeoJSON(
        diffedShapes,
        ALL_SEGMENT_STATUSES_VISIBLE,
        preferFeedKeepingReroutes(diffedShapes),
        runLineStatus,
      );
      bounds = boundsOfLineFeatures({
        type: 'FeatureCollection',
        features: features.features.filter((f) => f.properties?.canonical_id === diffRouteFocus),
      });
    }
    if (bounds) map.fitBounds(bounds, { padding: 60, duration: 500, maxZoom: 15 });
    // Deliberately keyed only on the token: a plain click on a line should
    // focus/highlight it without zooming, so `diffRouteFocus` etc. must not
    // be dependencies here — only the explicit "Show full line" button
    // (which bumps the token) should trigger this fit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffRouteZoomToken, ready]);

  const legendItems: Array<{ id: GeomStatus; label: string }> = [
    { id: 'unchanged', label: 'Unchanged' },
    { id: 'removed', label: 'Removed' },
    { id: 'added', label: 'Added' },
    { id: 'changed', label: 'Rerouted' },
  ];

  return (
    <div className="network-diff-map-view">
      <div className="split-map-header">
        <span>Network overview</span>
      </div>
      <div className="network-diff-map">
        <div ref={containerRef} className="network-diff-map-canvas" />
        <BasemapControls />
        <div className="map-mode-legend">
          {analysisMode === 'frequency'
            ? <FrequencyLegend />
            : legendItems.map(({ id, label }) => (
                <label key={id} className={`diff-count ${diffSegmentVisibility[id] ? 'on' : 'off'}`}>
                  <input
                    type="checkbox"
                    checked={diffSegmentVisibility[id]}
                    onChange={() => toggleDiffSegmentVisibility(id)}
                  />
                  <span className="diff-count-swatch diff-count-swatch--line" style={{ background: SEGMENT_COLOR[id] }} />
                  <span className="diff-count-label">{label}</span>
                </label>
              ))}
          {analysisMode !== 'frequency' && STOP_LEGEND.map(({ id, label }) => (
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
