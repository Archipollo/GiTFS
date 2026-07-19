// Single-map diff overview: the whole network on one map, all statuses
// (added/removed/rerouted/unchanged) visible simultaneously. This is the
// default diff-mode overview; SplitMapView (old feed / new feed side by
// side) is an opt-in alternative toggled from DiffControlBar. Unlike the two
// SplitMapView panes, this single map also shows the stop-diff dots
// (added/removed/moved/renamed, unchanged hidden by default) — one map
// instance keeps the cost low enough that the "geometry-only" scope that
// still applies to split view isn't needed here.

import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import type { DiffedShapes, GeomStatus } from '../gtfs/segment-graph';
import { SEGMENT_COLOR, segmentDiffToGeoJSON, preferFeedKeepingReroutes } from '../gtfs/segment-graph';
import { DIFF_COLOR, STOP_LEGEND, diffStopPoints, diffStopGhosts, diffMoveArrows } from './geojson';
import { useDiff } from './useDiff';
import { yearOfFeed } from '../timeline/math';
import { BasemapControls } from '../map/BasemapControls';
import { useBasemap } from '../map/basemap';
import {
  createDiffMapStyle,
  FIRST_DIFF_LAYER_ID,
  addDiffSegmentLayers,
  addDiffStopLayers,
  attachDiffSegmentClickHandler,
  boundsOfLineFeatures,
  emptyFC,
  setSource,
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
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  // Stop-diff shares the same cached (A,B) result the detail view already
  // computed — `useDiff` hits `peekDiff`, so this second caller adds no worker
  // work for a pair that's already been diffed.
  const diffStatus = useDiff(activeFeedId, compareFeedId);
  // Auto-fit once per feed pair — re-armed whenever `diffedShapes` swaps in a
  // new pair (see the effect below), so switching A/B refits the camera.
  const fittedForRef = useRef<DiffedShapes | null>(null);

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
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      addDiffSegmentLayers(map);
      // Network overview: labels only once the user zooms into an area.
      addDiffStopLayers(map, { labelMinZoom: 12 });
      attachDiffSegmentClickHandler(map, setDiffRouteFocus);
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
    );
    setSource(map, 'diff-segments', features);

    if (fittedForRef.current !== diffedShapes) {
      const bounds = boundsOfLineFeatures(features);
      if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 13 });
      fittedForRef.current = diffedShapes;
    }
  }, [diffedShapes, diffSegmentVisibility, ready]);

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

  // Station-name labels on/off (zoom gating is handled by the layer's minzoom).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('diff-stops-labels')) return;
    map.setLayoutProperty('diff-stops-labels', 'visibility', diffStopLabels ? 'visible' : 'none');
  }, [diffStopLabels, ready]);

  const legendItems: Array<{ id: GeomStatus; label: string }> = [
    { id: 'unchanged', label: 'Shared geometry' },
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
          {legendItems.map(({ id, label }) => (
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
      </div>
    </div>
  );
}
