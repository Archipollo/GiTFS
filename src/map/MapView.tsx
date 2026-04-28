import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, {
  Map as MapLibreMap,
  type ExpressionSpecification,
  type FilterSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import {
  fetchStops,
  fetchShapes,
  fetchShapeRouteMap,
  type StopPoint,
  type ShapePolyline,
} from '../gtfs/queries';
import { MODES, MODE_COLOR, type Mode } from '../gtfs/modes';
import MapOverlay from './MapOverlay';
import { useRegistry } from '../registry/useRegistry';
import { lookupStop, lookupRoute } from '../registry/registry';
import { useDiff } from '../diff/useDiff';
import {
  DIFF_COLOR,
  diffMoveArrows,
  diffStopGhosts,
  diffStopPoints,
} from '../diff/geojson';
import {
  SEGMENT_COLOR,
  dropDiffCache,
  dropShapeIndex,
  getDiffedShapes,
  getShapeIndex,
  resolveClickedRun,
  segmentDiffToGeoJSON,
  type DiffedRun,
  type DiffedShapes,
} from '../gtfs/segment-graph';
import { getRoutesForShape } from '../inspector/data';

const INITIAL_CENTER: [number, number] = [14.55, 47.6];
const INITIAL_ZOOM = 6.5;

const PRIMARY_COLOR_EXPR: ExpressionSpecification = [
  'match',
  ['get', 'primary_mode'],
  'rail', MODE_COLOR.rail,
  'metro', MODE_COLOR.metro,
  'tram', MODE_COLOR.tram,
  'bus', MODE_COLOR.bus,
  MODE_COLOR.other,
];

const DIFF_COLOR_EXPR: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  'added', DIFF_COLOR.added,
  'removed', DIFF_COLOR.removed,
  'moved', DIFF_COLOR.moved,
  'renamed', DIFF_COLOR.renamed,
  'unchanged', DIFF_COLOR.unchanged,
  '#94a3b8',
];

// Segment-level line diff uses one layer per geom_status (each with its
// own static line-color), so no match-expression is needed here.

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

interface FeedRender {
  stops: GeoJSON.FeatureCollection;
  shapes: GeoJSON.FeatureCollection;
  /** Raw shape polylines, kept alongside the prebuilt FC for diff reuse. */
  shapesRaw: ShapePolyline[];
  /** `shape_id → route_ids[]` (most-tripped first). Empty if feed has no shapes. */
  shapeToRoute: Map<string, string[]>;
  bounds: maplibregl.LngLatBoundsLike | null;
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const showStops = useAppStore((s) => s.showStops);
  const modeVisibility = useAppStore((s) => s.modeVisibility);
  const beginMapTask = useAppStore((s) => s.beginMapTask);
  const endMapTask = useAppStore((s) => s.endMapTask);
  const activeFeedLabel = useAppStore((s) =>
    s.activeFeedId ? s.feeds[s.activeFeedId]?.label : null,
  );
  const setInspectorStop = useAppStore((s) => s.setInspectorStop);
  const setInspectorRoute = useAppStore((s) => s.setInspectorRoute);
  const clearInspector = useAppStore((s) => s.clearInspector);
  const registrySnapshot = useRegistry();
  const registryFocus = useAppStore((s) => s.registryFocus);

  // Diff mode plumbing -----------------------------------------------------
  const appMode = useAppStore((s) => s.mode);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const setDiffSegmentSummary = useAppStore((s) => s.setDiffSegmentSummary);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const diffStatus = useDiff(
    appMode === 'diff' ? activeFeedId : null,
    appMode === 'diff' ? compareFeedId : null,
  );
  const diffActive = diffStatus.kind === 'ready';
  // Cached result of the expensive off-thread diffShapes computation.
  // Only changes when the feed pair changes, not when visibility toggles.
  const [diffedShapes, setDiffedShapes] = useState<DiffedShapes | null>(null);

  // Prebuilt-GeoJSON cache keyed by feedId. Populated lazily on first view of
  // a feed and proactively by the background prefetcher. Once a feed is here,
  // switching to it costs one `setData` call — scrubbing the year slider is
  // effectively instant.
  const cacheRef = useRef<Map<string, FeedRender>>(new Map());
  // In-flight fetch promises to dedupe concurrent requests for the same feed.
  const pendingRef = useRef<Map<string, Promise<FeedRender>>>(new Map());
  // Auto-fit the map once; subsequent feed switches must not jump the camera
  // (scrubbing relies on a stable viewport to show differences).
  const fittedRef = useRef(false);

  const ensureFeedRender = useCallback(async (feedId: string): Promise<FeedRender> => {
    const cached = cacheRef.current.get(feedId);
    if (cached) return cached;
    const pending = pendingRef.current.get(feedId);
    if (pending) return pending;
    const p = (async () => {
      const [stops, shapes, shapeToRoute] = await Promise.all([
        fetchStops(feedId),
        fetchShapes(feedId),
        fetchShapeRouteMap(feedId),
      ]);
      const entry: FeedRender = {
        stops: stopsToGeoJSON(stops),
        shapes: shapesToGeoJSON(shapes),
        shapesRaw: shapes,
        shapeToRoute,
        bounds: stops.length > 0 ? boundsOfStops(stops) : null,
      };
      cacheRef.current.set(feedId, entry);
      pendingRef.current.delete(feedId);
      return entry;
    })();
    pendingRef.current.set(feedId, p);
    return p;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      map.addSource('stops', { type: 'geojson', data: emptyFC() });
      map.addSource('shapes', { type: 'geojson', data: emptyFC() });
      map.addSource('registry-focus', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-segments', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-ghost', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-arrow', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'shapes-line',
        type: 'line',
        source: 'shapes',
        paint: {
          'line-color': PRIMARY_COLOR_EXPR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2.2],
          'line-opacity': 0.8,
        },
      });

      // Segment-level line diff. Unchanged sits at the bottom as a legible
      // neutral network backdrop, while added/removed strokes get stronger
      // casing so the actual changes still read first. All layers are hidden
      // in non-diff modes by the visibility
      // effect further down.
      map.addLayer({
        id: 'diff-segments-unchanged-casing',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'unchanged'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f8fafc',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.0, 14, 4.0],
          'line-opacity': 0.55,
        },
      });
      map.addLayer({
        id: 'diff-segments-unchanged-line',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'unchanged'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': SEGMENT_COLOR.unchanged,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 14, 2.8],
          'line-opacity': 0.82,
        },
      });
      map.addLayer({
        id: 'diff-segments-removed-casing',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'removed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1a1f2b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 14, 6.5],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'diff-segments-removed-line',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'removed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': SEGMENT_COLOR.removed,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.0, 14, 4.5],
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'diff-segments-added-casing',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'added'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1a1f2b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 14, 6.5],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'diff-segments-added-line',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'added'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': SEGMENT_COLOR.added,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.0, 14, 4.5],
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'stops-circle',
        type: 'circle',
        source: 'stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 4],
          'circle-color': PRIMARY_COLOR_EXPR,
          'circle-stroke-color': '#0f1115',
          'circle-stroke-width': 0.5,
          'circle-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'registry-focus-halo',
        type: 'circle',
        source: 'registry-focus',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 26],
          'circle-color': '#ffffff',
          'circle-opacity': 0,
          'circle-stroke-color': '#fbbf24',
          'circle-stroke-width': 3,
        },
      });

      // Diff overlay layers: invisible (empty sources) in non-diff modes.
      // Order matters: arrows under everything, then ghosts, then colored dots.
      map.addLayer({
        id: 'diff-arrow-line',
        type: 'line',
        source: 'diff-arrow',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': DIFF_COLOR.moved,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 2],
          'line-opacity': 0.85,
          'line-dasharray': [1.5, 1.5],
        },
      });
      map.addLayer({
        id: 'diff-ghost-circle',
        type: 'circle',
        source: 'diff-ghost',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 4],
          'circle-color': DIFF_COLOR.moved,
          'circle-opacity': 0.35,
          'circle-stroke-color': '#0f1115',
          'circle-stroke-width': 0.5,
        },
      });
      map.addLayer({
        id: 'diff-stops-circle',
        type: 'circle',
        source: 'diff-stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 5.5],
          'circle-color': DIFF_COLOR_EXPR,
          'circle-stroke-color': '#0f1115',
          'circle-stroke-width': 0.5,
          'circle-opacity': [
            'case',
            ['==', ['get', 'status'], 'unchanged'], 0.55,
            0.95,
          ],
        },
      });
      map.on('mouseenter', 'diff-stops-circle', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'diff-stops-circle', () => {
        map.getCanvas().style.cursor = '';
      });
      map.on('click', 'diff-stops-circle', (evt) => {
        const f = evt.features?.[0];
        if (!f) return;
        const canonicalId = String(f.properties?.canonicalId ?? '');
        if (!canonicalId) return;
        useAppStore.getState().setDiffStopFocus(canonicalId);
      });

      // Diff segment → route focus. Each run feature carries its
      // originating feed ('a' | 'b') and its shape_id verbatim, so we
      // resolve shape → route → canonical route directly without any
      // ambiguity about which feed's registry to look in.
      for (const layerId of [
        'diff-segments-added-line',
        'diff-segments-removed-line',
        'diff-segments-unchanged-line',
      ]) {
        map.on('mouseenter', layerId, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
        });
        map.on('click', layerId, (evt) => {
          const f = evt.features?.[0];
          if (!f) return;
          const st = useAppStore.getState();
          const a = st.activeFeedId;
          const b = st.compareFeedId;
          if (!a || !b) return;
          const pick = resolveClickedRun(f.properties ?? {}, a, b);
          if (!pick) return;
          getRoutesForShape(pick.feedId, pick.shapeId)
            .then((routeIds) => {
              if (routeIds.length === 0) return;
              const canonical = lookupRoute(pick.feedId, routeIds[0])?.canonicalId ?? null;
              if (canonical) useAppStore.getState().setDiffRouteFocus(canonical);
            })
            .catch((err) => console.warn('segment → route resolve failed', err));
        });
      }

      map.on('mouseenter', 'stops-circle', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'stops-circle', () => {
        map.getCanvas().style.cursor = '';
      });
      map.on('click', 'stops-circle', (evt) => {
        const feature = evt.features?.[0];
        if (!feature) return;
        const props = feature.properties ?? {};
        const activeId = useAppStore.getState().activeFeedId;
        if (!activeId) return;
        const rawId = String(props.stop_id ?? '');
        const canonical = lookupStop(activeId, rawId)?.canonicalId ?? null;
        setInspectorStop({
          feedId: activeId,
          rawId,
          stopName: String(props.stop_name ?? ''),
          modes: modesFromProps(props),
          canonicalId: canonical,
        });
      });

      map.on('mouseenter', 'shapes-line', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'shapes-line', () => {
        map.getCanvas().style.cursor = '';
      });
      map.on('click', 'shapes-line', (evt) => {
        const feature = evt.features?.[0];
        if (!feature) return;
        const props = feature.properties ?? {};
        const shapeId = String(props.shape_id ?? '');
        const activeId = useAppStore.getState().activeFeedId;
        if (!activeId || !shapeId) return;
        // Resolve shape → route_id async (cached). The inspector will stay
        // showing its previous selection until this resolves — which is
        // effectively instant after the first click on any shape per feed.
        getRoutesForShape(activeId, shapeId)
          .then((routeIds) => {
            if (routeIds.length === 0) return;
            const routeId = routeIds[0];
            const canonical = lookupRoute(activeId, routeId)?.canonicalId ?? null;
            const appMode = useAppStore.getState().mode;
            if (appMode === 'diff' && canonical) {
              useAppStore.getState().setDiffRouteFocus(canonical);
            } else {
              setInspectorRoute({
                feedId: activeId,
                rawId: routeId,
                shapeId,
                canonicalId: canonical,
              });
            }
          })
          .catch((err) => console.warn('shape→route resolve failed', err));
      });

      map.on('click', (evt) => {
        const hit = map.queryRenderedFeatures(evt.point, {
          layers: [
            'stops-circle',
            'shapes-line',
            'diff-stops-circle',
            'diff-segments-added-line',
            'diff-segments-removed-line',
            'diff-segments-unchanged-line',
          ],
        });
        if (hit.length === 0) {
          clearInspector();
          useAppStore.getState().clearDiffFocus();
        }
      });
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [setInspectorStop, setInspectorRoute, clearInspector]);

  // Swap visible feed. Cache hit = instant setData, no spinner, no camera move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!activeFeedId) {
      setSource(map, 'stops', emptyFC());
      setSource(map, 'shapes', emptyFC());
      clearInspector();
      return;
    }

    let cancelled = false;
    const apply = (entry: FeedRender) => {
      if (cancelled) return;
      setSource(map, 'stops', entry.stops);
      setSource(map, 'shapes', entry.shapes);
      if (!fittedRef.current && entry.bounds) {
        map.fitBounds(entry.bounds, { padding: 40, duration: 600, maxZoom: 12 });
        fittedRef.current = true;
      }
    };

    const cached = cacheRef.current.get(activeFeedId);
    if (cached) {
      apply(cached);
      return () => {
        cancelled = true;
      };
    }

    const taskId = `render-${activeFeedId}`;
    beginMapTask(taskId, `Rendering ${activeFeedLabel ?? activeFeedId}…`);
    ensureFeedRender(activeFeedId)
      .then(apply)
      .catch((err) => console.error('map render failed', err))
      .finally(() => endMapTask(taskId));

    return () => {
      cancelled = true;
      endMapTask(taskId);
    };
  }, [activeFeedId, ready, activeFeedLabel, beginMapTask, endMapTask, ensureFeedRender, clearInspector]);

  // Prebuild GeoJSON for every loaded feed once the map is up, so scrubbing
  // the year slider never blocks on DuckDB. The active feed always wins the
  // race because the effect above runs first; this only fills in the rest.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const ids = feedOrder.filter((id) => !cacheRef.current.has(id));
    (async () => {
      for (const id of ids) {
        if (cancelled) return;
        try {
          await ensureFeedRender(id);
        } catch (err) {
          console.warn('map prefetch failed', id, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, feedOrder, ensureFeedRender]);

  // Drop cache entries for feeds the user has removed. Also evict the
  // segment-graph caches so a later re-ingest of the same id doesn't
  // reuse stale geometry or stale diff results.
  useEffect(() => {
    const valid = new Set(feedOrder);
    for (const key of [...cacheRef.current.keys()]) {
      if (!valid.has(key)) {
        cacheRef.current.delete(key);
        dropShapeIndex(key);
        dropDiffCache(key);
      }
    }
    for (const key of [...pendingRef.current.keys()]) {
      if (!valid.has(key)) pendingRef.current.delete(key);
    }
  }, [feedOrder]);

  // Reapply filters when toggles change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const activeModes = MODES.filter((m) => modeVisibility[m]);
    const modeFilter: FilterSpecification = modeMatchFilter(activeModes);

    map.setLayoutProperty('stops-circle', 'visibility', showStops ? 'visible' : 'none');
    map.setFilter('stops-circle', modeFilter);
    map.setFilter('shapes-line', modeFilter);

    // Segment diff layers keep only their geom_status predicate here —
    // mode filtering is applied at GeoJSON emit time (see the `accept`
    // in the diff-segments effect) so the sidebar length totals stay
    // consistent with what's actually drawn.
  }, [showStops, modeVisibility, ready]);

  // Drive the canonical-entity focus halo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!registryFocus) {
      setSource(map, 'registry-focus', emptyFC());
      return;
    }
    let lat = registryFocus.lat;
    let lon = registryFocus.lon;
    if ((lat == null || lon == null) && registrySnapshot && registryFocus.kind === 'stop') {
      const canon = registrySnapshot.stops[registryFocus.canonicalId];
      if (canon) { lat = canon.lat; lon = canon.lon; }
    }
    if (lat == null || lon == null) {
      setSource(map, 'registry-focus', emptyFC());
      return;
    }
    setSource(map, 'registry-focus', {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { canonicalId: registryFocus.canonicalId },
      }],
    });
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13), duration: 700 });
  }, [registryFocus, ready, registrySnapshot]);

  // Populate / clear diff overlay sources. Stop overlays are synchronous
  // (already in the diff result); shape overlays join registry route ids
  // against cached per-feed shape data, which may still be loading for one
  // of the two feeds — we run it as an effect that re-runs on every input
  // and cancels stale work.
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

  // Effect A — compute the segment diff in a Web Worker.
  // Only re-runs when the feed pair changes, not on visibility toggles.
  // The result is cached inside getDiffedShapes, so switching back to a
  // previously seen pair is instant.
  useEffect(() => {
    if (diffStatus.kind !== 'ready') {
      setDiffedShapes(null);
      return;
    }
    let cancelled = false;
    const feedA = diffStatus.feedA;
    const feedB = diffStatus.feedB;
    (async () => {
      try {
        const [idxA, idxB] = await Promise.all([
          getShapeIndex(feedA),
          getShapeIndex(feedB),
        ]);
        if (cancelled) return;
        const t0 = performance.now();
        const diffed = await getDiffedShapes(idxA, idxB);
        if (cancelled) return;
        const dtMs = Math.round(performance.now() - t0);
        console.info('[diff-segments] computed', {
          feedA,
          feedB,
          runs: diffed.runs.length,
          dtMs,
        });
        setDiffedShapes(diffed);
      } catch (err) {
        if (!cancelled) console.warn('diff-segments compute failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diffStatus]);

  // Effect B — convert the cached diff result to GeoJSON for MapLibre.
  // Runs cheaply whenever visibility or mode filters change, without
  // re-doing any spatial computation.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffedShapes) {
      setSource(map, 'diff-segments', emptyFC());
      setDiffSegmentSummary(null);
      return;
    }
    const activeModes = new Set(MODES.filter((m) => modeVisibility[m]));
    const accept = (r: DiffedRun) => {
      const modes = r.modes.length ? r.modes : (['other'] as Mode[]);
      return modes.some((m) => activeModes.has(m));
    };
    const { features, lengths } = segmentDiffToGeoJSON(
      diffedShapes,
      diffSegmentVisibility,
      accept,
    );
    console.info('[diff-segments] rendered', {
      features: features.features.length,
      lengthsKm: {
        added: Math.round(lengths.added / 1000),
        removed: Math.round(lengths.removed / 1000),
        unchanged: Math.round(lengths.unchanged / 1000),
      },
    });
    setSource(map, 'diff-segments', features);
    setDiffSegmentSummary({ feedA: diffedShapes.feedA, feedB: diffedShapes.feedB, lengths });
  }, [
    diffedShapes,
    diffSegmentVisibility,
    modeVisibility,
    ready,
    setDiffSegmentSummary,
  ]);

  // In diff mode: hide per-feed stops, hide base shapes entirely, and show
  // the diff polyline + dot overlays instead.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const showDiffOverlay = appMode === 'diff' && diffActive;
    map.setLayoutProperty(
      'stops-circle',
      'visibility',
      !showDiffOverlay && showStops ? 'visible' : 'none',
    );
    // The base shapes layer would duplicate (and recolor) the diff polylines
    // in diff mode, so we hide it completely rather than just dimming it.
    map.setLayoutProperty(
      'shapes-line',
      'visibility',
      showDiffOverlay ? 'none' : 'visible',
    );
    const vis = showDiffOverlay ? 'visible' : 'none';
    map.setLayoutProperty('diff-stops-circle', 'visibility', vis);
    map.setLayoutProperty('diff-ghost-circle', 'visibility', vis);
    map.setLayoutProperty('diff-arrow-line', 'visibility', vis);
    for (const id of [
      'diff-segments-unchanged-casing',
      'diff-segments-unchanged-line',
      'diff-segments-removed-casing',
      'diff-segments-removed-line',
      'diff-segments-added-casing',
      'diff-segments-added-line',
    ]) {
      map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [appMode, diffActive, ready, showStops]);

  // Fly to the focused diff stop.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffStopFocus || diffStatus.kind !== 'ready') return;
    const entry = diffStatus.result.stops.find((e) => e.canonicalId === diffStopFocus);
    if (!entry) return;
    const coord = entry.b
      ? [entry.b.lon, entry.b.lat]
      : entry.a
        ? [entry.a.lon, entry.a.lat]
        : [entry.canonical.lon, entry.canonical.lat];
    map.flyTo({
      center: coord as [number, number],
      zoom: Math.max(map.getZoom(), 14),
      duration: 600,
    });
  }, [diffStopFocus, diffStatus, ready]);

  // Fit to the focused diff route's shapes across both sides. Routes rarely
  // fit a single tile, so we fitBounds instead of flyTo, and we keep the
  // current zoom as a ceiling so the user isn't yanked out on long lines.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffRouteFocus || diffStatus.kind !== 'ready' || !registrySnapshot) return;
    const entry = diffStatus.result.routes.find(
      (e) => e.canonicalId === diffRouteFocus,
    );
    if (!entry) return;
    const fromCid = entry.renumbering
      ? entry.renumbering.fromCanonicalId
      : entry.canonicalId;
    const toCid = entry.renumbering
      ? entry.renumbering.toCanonicalId
      : entry.canonicalId;

    const aRender = cacheRef.current.get(diffStatus.feedA);
    const bRender = cacheRef.current.get(diffStatus.feedB);
    const coords: [number, number][] = [];
    const collect = (
      render: FeedRender | undefined,
      feedId: string,
      cid: string,
    ) => {
      if (!render) return;
      for (const shape of render.shapesRaw) {
        const rids = render.shapeToRoute.get(shape.shape_id);
        if (!rids) continue;
        const hit = rids.some(
          (rid) => registrySnapshot.routeAssignments[`${feedId}\t${rid}`] === cid,
        );
        if (hit) coords.push(...shape.coords);
      }
    };
    collect(aRender, diffStatus.feedA, fromCid);
    collect(bRender, diffStatus.feedB, toCid);
    if (coords.length === 0) return;

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 60,
      duration: 600,
      maxZoom: Math.max(map.getZoom(), 12),
    });
  }, [diffRouteFocus, diffStatus, registrySnapshot, ready]);

  return (
    <>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <MapOverlay />
    </>
  );
}

/**
 * Build a MapLibre filter that keeps a feature iff at least one of its modes is active.
 * Relies on per-feature boolean flags `is_rail`, `is_metro`, ... written by the GeoJSON builders.
 * If *no* modes are active, nothing is shown.
 */
function modeMatchFilter(activeModes: Mode[]): FilterSpecification {
  if (activeModes.length === 0) {
    return ['==', ['literal', 1], ['literal', 0]]; // hide everything
  }
  const clauses: ExpressionSpecification[] = activeModes.map(
    (m) => ['==', ['get', `is_${m}`], true] as ExpressionSpecification,
  );
  return ['any', ...clauses] as unknown as FilterSpecification;
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function setSource(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
}

function modeFlags(modes: Mode[]): Record<string, boolean> {
  // Stops/shapes never served by anything still need a flag so they can be filtered
  // via the 'other' bucket.
  const effective = modes.length ? modes : (['other'] as Mode[]);
  const flags: Record<string, boolean> = {};
  for (const m of MODES) flags[`is_${m}`] = effective.includes(m);
  return flags;
}

function modesFromProps(props: Record<string, unknown>): Mode[] {
  return MODES.filter((m) => {
    const v = props[`is_${m}`];
    return v === true || v === 'true' || v === 1 || v === '1';
  });
}

function stopsToGeoJSON(stops: StopPoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stops.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        stop_id: s.stop_id,
        stop_name: s.stop_name,
        primary_mode: s.modes.length ? s.primary_mode : 'other',
        ...modeFlags(s.modes),
      },
    })),
  };
}

function shapesToGeoJSON(shapes: ShapePolyline[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shapes.map((s) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: s.coords },
      properties: {
        shape_id: s.shape_id,
        primary_mode: s.modes.length ? s.primary_mode : 'other',
        ...modeFlags(s.modes),
      },
    })),
  };
}

function boundsOfStops(stops: { lat: number; lon: number }[]): maplibregl.LngLatBoundsLike {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const s of stops) {
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
  }
  return [[minLon, minLat], [maxLon, maxLat]];
}
