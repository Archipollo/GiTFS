// Synchronized split view: two independent MapLibre instances, old feed on
// the left and new feed on the right, panned/zoomed in lockstep. Each pane
// draws its own feed's geometry plus that feed's stops (left = feed A, right =
// feed B), so a moved stop shows displaced between the panes and added/removed
// stops appear on only the side that has them. Frequency stays route-scoped in
// RouteDetailView.

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import type { DiffedShapes, GeomStatus } from '../gtfs/segment-graph';
import { SEGMENT_COLOR, segmentDiffToGeoJSON, preferFeed, buildRunLineStatus } from '../gtfs/segment-graph';
import { DIFF_COLOR, STOP_LEGEND, diffStopPointsForFeed } from './geojson';
import { useDiff } from './useDiff';
import { yearOfFeed } from '../timeline/math';
import { BasemapControls } from '../map/BasemapControls';
import { useBasemap } from '../map/basemap';
import { usePersistedCamera } from '../map/usePersistedCamera';
import {
  createDiffMapStyle,
  FIRST_DIFF_LAYER_ID,
  addDiffSegmentLayers,
  addDiffStopLayers,
  attachDiffSegmentClickHandler,
  attachDiffStopClickHandler,
  setDiffRouteHighlight,
  setDiffStopHighlight,
  boundsOfLineFeatures,
  emptyFC,
  setSource,
} from './diffMapLayers';

const INITIAL_CENTER: [number, number] = [14.55, 47.6];
const INITIAL_ZOOM = 6.5;

/** Which side ('old' | 'new') shows each geometry status. `unchanged` shows
 * on both — it's the shared network backdrop for orientation. */
const SIDE_STATUS: Record<'old' | 'new', GeomStatus[]> = {
  old: ['unchanged', 'removed'],
  new: ['unchanged', 'added'],
};

interface PaneProps {
  side: 'old' | 'new';
  diffedShapes: DiffedShapes | null;
  otherMapRef: { current: MapLibreMap | null };
  syncingRef: { current: boolean };
  onReady: (map: MapLibreMap) => void;
}

function MapPane({ side, diffedShapes, otherMapRef, syncingRef, onReady }: PaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffStopFocus = useAppStore((s) => s.setDiffStopFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  // Both panes read the same cached (A,B) diff — `useDiff` hits `peekDiff`, so
  // the second pane adds no worker work for an already-diffed pair.
  const diffStatus = useDiff(activeFeedId, compareFeedId);
  const runLineStatus = useMemo(
    () => (diffStatus.kind === 'ready' ? buildRunLineStatus(diffStatus.result.routes) : undefined),
    [diffStatus],
  );
  // Only the 'old' pane fits bounds — its 'move' handler syncs the 'new' pane
  // to match, so fitting both would race and jitter the camera.
  const fittedForRef = useRef<DiffedShapes | null>(null);
  // Restored camera (a layout switch) counts as already-fitted for the 'old'
  // pane, so switching into split keeps the current view; a later A/B swap
  // still refits (pair identity changes).
  const skipInitialFitRef = useRef(!!useAppStore.getState().mapCamera);

  // Both panes construct from the shared camera so they start in sync, but only
  // the driver ('old') pane writes moveend updates back — the 'new' pane merely
  // follows via the 'move' sync below, so letting it write would double up.
  const initialCamera = usePersistedCamera(mapRef, ready, side === 'old');

  // Each pane's satellite imagery matches the feed whose geometry it draws —
  // the same A/B mapping the segment source uses below — so the two panes show
  // their own era side by side.
  const paneYear = useAppStore((s) => {
    if (!diffedShapes) return null;
    const feedId = side === 'old' ? diffedShapes.feedA : diffedShapes.feedB;
    const meta = s.feeds[feedId];
    return meta ? yearOfFeed(meta).year : null;
  });
  useBasemap(mapRef, ready, paneYear, FIRST_DIFF_LAYER_ID);

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
      // Split panes are network-scale like the overview: gate labels to z12+.
      addDiffStopLayers(map, { labelMinZoom: 12 });

      map.on('move', () => {
        if (syncingRef.current) return;
        const other = otherMapRef.current;
        if (!other) return;
        syncingRef.current = true;
        other.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
        syncingRef.current = false;
      });

      attachDiffSegmentClickHandler(map, setDiffRouteFocus);
      attachDiffStopClickHandler(map, setDiffStopFocus);

      // The other pane may already have fitted its camera while this one was
      // still loading — its 'move' sync would have found a null ref and given
      // up. Pull the current camera once on load so late maps catch up.
      const other = otherMapRef.current;
      if (other) {
        syncingRef.current = true;
        map.jumpTo({ center: other.getCenter(), zoom: other.getZoom(), bearing: other.getBearing(), pitch: other.getPitch() });
        syncingRef.current = false;
      }

      setReady(true);
      onReady(map);
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
    const allowed = new Set(SIDE_STATUS[side]);
    // Each pane draws one feed's own network, so it takes that feed's copy of
    // the shared corridors — the 'new' pane taking the A-side copy would leave
    // its reroutes ending just short of the grey they continue into.
    const { features } = segmentDiffToGeoJSON(
      diffedShapes,
      diffSegmentVisibility,
      preferFeed(side === 'old' ? 'a' : 'b'),
      runLineStatus,
    );
    // Further restrict to this pane's side on top of the shared
    // diffSegmentVisibility toggle (both gate independently).
    const sideFiltered: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: features.features.filter((feat) => {
        const status = String(feat.properties?.geom_status ?? '') as GeomStatus;
        if (status === 'changed') {
          const wantSide = side === 'old' ? 'old' : 'new';
          return feat.properties?.changed_side === wantSide;
        }
        return allowed.has(status);
      }),
    };
    setSource(map, 'diff-segments', sideFiltered);

    if (side === 'old') {
      if (skipInitialFitRef.current) {
        fittedForRef.current = diffedShapes;
        skipInitialFitRef.current = false;
      }
      if (fittedForRef.current !== diffedShapes) {
        const bounds = boundsOfLineFeatures(features);
        if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 13 });
        fittedForRef.current = diffedShapes;
      }
    }
  }, [diffedShapes, diffSegmentVisibility, runLineStatus, ready, side]);

  // This pane's own stops, at this feed's positions. Ghost/arrow layers stay
  // empty here — displacement is shown by the moved stop appearing on both
  // panes, so the single-map ghost+arrow treatment isn't needed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (diffStatus.kind !== 'ready') {
      setSource(map, 'diff-stops', emptyFC());
      return;
    }
    setSource(
      map,
      'diff-stops',
      diffStopPointsForFeed(diffStatus.result, diffStopVisibility, side === 'old' ? 'a' : 'b'),
    );
  }, [diffStatus, diffStopVisibility, ready, side]);

  // Station-name labels on/off (zoom gating is the layer's minzoom).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('diff-stops-labels')) return;
    map.setLayoutProperty('diff-stops-labels', 'visibility', diffStopLabels ? 'visible' : 'none');
  }, [diffStopLabels, ready]);

  // Violet halo on the inspector-focused line/stop, mirrored on both panes so a
  // moved stop is highlighted at its before and after position at once.
  useEffect(() => {
    if (mapRef.current && ready) setDiffRouteHighlight(mapRef.current, diffRouteFocus);
  }, [diffRouteFocus, ready]);
  useEffect(() => {
    if (mapRef.current && ready) setDiffStopHighlight(mapRef.current, diffStopFocus);
  }, [diffStopFocus, ready]);

  return <div ref={containerRef} className="split-map-pane" />;
}

export function SplitMapView({ diffedShapes }: { diffedShapes: DiffedShapes | null }) {
  const mapOldRef = useRef<MapLibreMap | null>(null);
  const mapNewRef = useRef<MapLibreMap | null>(null);
  const syncingRef = useRef(false);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const toggleDiffSegmentVisibility = useAppStore((s) => s.toggleDiffSegmentVisibility);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const toggleDiffStopVisibility = useAppStore((s) => s.toggleDiffStopVisibility);
  const diffStopLabels = useAppStore((s) => s.diffStopLabels);
  const toggleDiffStopLabels = useAppStore((s) => s.toggleDiffStopLabels);

  const legendItems: Array<{ id: GeomStatus; label: string }> = [
    { id: 'unchanged', label: 'Shared geometry' },
    { id: 'removed', label: 'Removed' },
    { id: 'added', label: 'Added' },
    { id: 'changed', label: 'Rerouted' },
  ];

  return (
    <div className="split-map-view">
      <div className="split-map-header">
        <span>A - Old feed (left)</span>
        <span>B - New feed (right)</span>
      </div>
      <div className="split-map-panes">
        <MapPane
          side="old"
          diffedShapes={diffedShapes}
          otherMapRef={mapNewRef}
          syncingRef={syncingRef}
          onReady={(map) => { mapOldRef.current = map; }}
        />
        <MapPane
          side="new"
          diffedShapes={diffedShapes}
          otherMapRef={mapOldRef}
          syncingRef={syncingRef}
          onReady={(map) => { mapNewRef.current = map; }}
        />
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
