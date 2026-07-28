import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, {
  Map as MapLibreMap,
  type ExpressionSpecification,
  type FilterSpecification,
  type PointLike,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import { yearOfFeed } from '../timeline/math';
import {
  fetchStops,
  fetchShapes,
  fetchShapeRouteMap,
  type StopPoint,
  type ShapePolyline,
} from '../gtfs/queries';
import { MODES, MODE_COLOR, MODE_LABEL, type Mode } from '../gtfs/modes';
import {
  getOrComputeFeedFrequency,
  feedFrequencyToGeoJSON,
  FEED_FREQUENCY_LOWEST_COLOR,
  FEED_FREQUENCY_LOW_COLOR,
  FEED_FREQUENCY_MID_COLOR,
  FEED_FREQUENCY_HIGH_COLOR,
  FEED_FREQUENCY_HIGHEST_COLOR,
  FEED_FREQUENCY_CLASS_BREAKS,
  FEED_FREQUENCY_MIN_WIDTH,
  FEED_FREQUENCY_MAX_WIDTH,
  type FeedFrequencyResult,
} from '../gtfs/frequency';
import { FrequencyLegend } from '../diff/FrequencyLegend';
import { PopulationLegend } from '../diff/PopulationLegend';
import {
  computeFeedPopulation,
  feedPopulationToGeoJSON,
  POPULATION_LOWEST_COLOR,
  POPULATION_LOW_COLOR,
  POPULATION_MID_COLOR,
  POPULATION_HIGH_COLOR,
  POPULATION_HIGHEST_COLOR,
  POPULATION_CLASS_BREAKS,
  POPULATION_FILL_OPACITY,
  type FeedPopulationResult,
  type Bbox,
} from '../gtfs/population';
import { getOrComputeZaehlsprengelPopulation, type ZaehlsprengelResult } from '../gtfs/zaehlsprengel';
import { attachPopulationTooltip, addGueteklassenLayer, attachGueteklassenTooltip } from '../diff/diffMapLayers';
import {
  computeFeedGueteklassen,
  feedGueteklassenToGeoJSON,
  dropFeedGueteklassenCache,
  type FeedGueteklassenResult,
} from '../gtfs/gueteklassen';
import { GueteklassenLegend } from '../diff/GueteklassenLegend';
import MapOverlay from './MapOverlay';
import { BasemapControls } from './BasemapControls';
import { basemapLayers, basemapSources, useBasemap } from './basemap';
import { useMapBounds } from './useMapBounds';
import { useRegistry } from '../registry/useRegistry';
import { lookupStop, lookupRoute } from '../registry/registry';
import { dropDiffCache, dropShapeIndex } from '../gtfs/segment-graph';
import { dropFeedFrequencyCache } from '../gtfs/frequency';
import { getRoutesForShape, getRouteDirections } from '../inspector/data';
import { usePersistedCamera } from './usePersistedCamera';

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

const makeStyle = (): maplibregl.StyleSpecification => ({
  version: 8,
  sources: basemapSources(),
  layers: basemapLayers(useAppStore.getState().mapStyle),
});

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
  const inspectorStop = useAppStore((s) => s.inspectorStop);
  const inspectorRoute = useAppStore((s) => s.inspectorRoute);
  const registrySnapshot = useRegistry();
  const registryFocus = useAppStore((s) => s.registryFocus);
  const pinnedEntities = useAppStore((s) => s.pinnedEntities);
  const analysisMode = useAppStore((s) => s.analysisMode);
  const setFeedFrequencySummary = useAppStore((s) => s.setFeedFrequencySummary);
  const setFeedPopulationSummary = useAppStore((s) => s.setFeedPopulationSummary);
  const populationSource = useAppStore((s) => s.populationSource);
  const setZaehlsprengelPopulationSummary = useAppStore((s) => s.setZaehlsprengelPopulationSummary);
  const setFeedGueteklassenSummary = useAppStore((s) => s.setFeedGueteklassenSummary);

  // Prebuilt-GeoJSON cache keyed by feedId. Populated lazily on first view of
  // a feed and proactively by the background prefetcher. Once a feed is here,
  // switching to it costs one `setData` call — scrubbing the year slider is
  // effectively instant.
  const cacheRef = useRef<Map<string, FeedRender>>(new Map());
  // In-flight fetch promises to dedupe concurrent requests for the same feed.
  const pendingRef = useRef<Map<string, Promise<FeedRender>>>(new Map());
  // Auto-fit the map once; subsequent feed switches must not jump the camera
  // (scrubbing relies on a stable viewport to show differences). A camera
  // restored from another overview layout counts as already-fitted, so
  // switching into timeline keeps the current view.
  const fittedRef = useRef(!!useAppStore.getState().mapCamera);

  const initialCamera = usePersistedCamera(mapRef, ready);

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
      style: makeStyle(),
      center: initialCamera?.center ?? INITIAL_CENTER,
      zoom: initialCamera?.zoom ?? INITIAL_ZOOM,
      bearing: initialCamera?.bearing ?? 0,
      pitch: initialCamera?.pitch ?? 0,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      map.addSource('stops', { type: 'geojson', data: emptyFC() });
      map.addSource('shapes', { type: 'geojson', data: emptyFC() });
      map.addSource('registry-focus', { type: 'geojson', data: emptyFC() });
      map.addSource('pinned-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-route-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-stop', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-shape', { type: 'geojson', data: emptyFC() });
      map.addSource('analysis-frequency', { type: 'geojson', data: emptyFC() });
      map.addSource('analysis-population', { type: 'geojson', data: emptyFC() });
      // Fill layer added before every line/circle layer below so the
      // population choropleth sits under routes and stops, not over them.
      map.addLayer({
        id: 'analysis-population-fill',
        type: 'fill',
        source: 'analysis-population',
        paint: {
          'fill-color': [
            'step',
            ['get', 'pop_norm'],
            POPULATION_LOWEST_COLOR,
            POPULATION_CLASS_BREAKS[0], POPULATION_LOW_COLOR,
            POPULATION_CLASS_BREAKS[1], POPULATION_MID_COLOR,
            POPULATION_CLASS_BREAKS[2], POPULATION_HIGH_COLOR,
            POPULATION_CLASS_BREAKS[3], POPULATION_HIGHEST_COLOR,
          ],
          'fill-opacity': POPULATION_FILL_OPACITY,
        },
      });
      attachPopulationTooltip(map, 'analysis-population-fill');
      // Same "under everything" placement as the population fill above.
      addGueteklassenLayer(map, 'analysis-gueteklassen', 'analysis-gueteklassen-fill');
      attachGueteklassenTooltip(map, 'analysis-gueteklassen-fill');
      // Width encodes trips/week (not just zoom): a low-frequency route stays
      // near the thin end at any zoom, a high-frequency one renders near the
      // thick end — same "magnitude in the line itself" treatment as the
      // diff-mode frequency overlay.
      // MapLibre allows only one zoom-based interpolate per expression, so
      // zoom must be the outer interpolate and magnitude the inner one.
      const feedMagnitudeWidthExpr: maplibregl.ExpressionSpecification = [
        'interpolate', ['linear'], ['zoom'],
        8, ['interpolate', ['linear'], ['get', 'trips_norm'], 0, FEED_FREQUENCY_MIN_WIDTH, 1, FEED_FREQUENCY_MIN_WIDTH + 0.8],
        14, ['interpolate', ['linear'], ['get', 'trips_norm'], 0, FEED_FREQUENCY_MIN_WIDTH + 0.6, 1, FEED_FREQUENCY_MAX_WIDTH],
      ];
      // MapLibre requires the zoom-based interpolate to be the property's
      // top-level expression, so the casing's "+2px" offset is baked into its
      // own copy's stops rather than wrapped around the line's expression.
      const feedMagnitudeCasingWidthExpr: maplibregl.ExpressionSpecification = [
        'interpolate', ['linear'], ['zoom'],
        8, ['interpolate', ['linear'], ['get', 'trips_norm'], 0, FEED_FREQUENCY_MIN_WIDTH + 2, 1, FEED_FREQUENCY_MIN_WIDTH + 2.8],
        14, ['interpolate', ['linear'], ['get', 'trips_norm'], 0, FEED_FREQUENCY_MIN_WIDTH + 2.6, 1, FEED_FREQUENCY_MAX_WIDTH + 2],
      ];
      map.addLayer({
        id: 'analysis-frequency-casing',
        type: 'line',
        source: 'analysis-frequency',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': feedMagnitudeCasingWidthExpr,
          'line-opacity': 0.55,
        },
      });
      map.addLayer({
        id: 'analysis-frequency-line',
        type: 'line',
        source: 'analysis-frequency',
        paint: {
          'line-color': [
            'step',
            ['get', 'trips_per_week'],
            FEED_FREQUENCY_LOWEST_COLOR,
            FEED_FREQUENCY_CLASS_BREAKS[0], FEED_FREQUENCY_LOW_COLOR,
            FEED_FREQUENCY_CLASS_BREAKS[1], FEED_FREQUENCY_MID_COLOR,
            FEED_FREQUENCY_CLASS_BREAKS[2], FEED_FREQUENCY_HIGH_COLOR,
            FEED_FREQUENCY_CLASS_BREAKS[3], FEED_FREQUENCY_HIGHEST_COLOR,
          ],
          'line-width': feedMagnitudeWidthExpr,
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'shapes-line-casing',
        type: 'line',
        source: 'shapes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 4.5],
          'line-opacity': 0.45,
        },
      });
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
      map.addLayer({
        id: 'stops-circle',
        type: 'circle',
        source: 'stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 4],
          'circle-color': PRIMARY_COLOR_EXPR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 1.8],
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
      map.addLayer({
        id: 'pinned-stop-halo',
        type: 'circle',
        source: 'pinned-stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 26],
          'circle-color': '#ffffff',
          'circle-opacity': 0,
          'circle-stroke-color': '#fbbf24',
          'circle-stroke-width': 3,
        },
      });
      map.addLayer({
        id: 'inspector-shape-casing',
        type: 'line',
        source: 'inspector-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 9],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'inspector-shape-line',
        type: 'line',
        source: 'inspector-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#fbbf24',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6],
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'inspector-route-stops-dot',
        type: 'circle',
        source: 'inspector-route-stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 5.5],
          'circle-color': PRIMARY_COLOR_EXPR,
          'circle-opacity': 1,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 1.5],
        },
      });
      map.addLayer({
        id: 'inspector-stop-halo',
        type: 'circle',
        source: 'inspector-stop',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 8],
          'circle-color': '#fbbf24',
          'circle-opacity': 0.9,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });

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
        const activeId = useAppStore.getState().activeFeedId;
        if (!activeId) return;
        // Query ALL shapes at the click point (not just the topmost feature) so
        // routes that overlap with different shape_ids are all included.
        const bbox: [PointLike, PointLike] = [
          [evt.point.x - 4, evt.point.y - 4],
          [evt.point.x + 4, evt.point.y + 4],
        ];
        const allFeatures = map.queryRenderedFeatures(bbox, { layers: ['shapes-line'] });
        const shapeIds = [...new Set(
          allFeatures.map((f) => String(f.properties?.shape_id ?? '')).filter(Boolean),
        )];
        if (shapeIds.length === 0) return;
        Promise.all(shapeIds.map((sid) => getRoutesForShape(activeId, sid)))
          .then((arrays) => {
            const seen = new Set<string>();
            const routeIds: string[] = [];
            for (const arr of arrays) {
              for (const rid of arr) {
                if (!seen.has(rid)) { seen.add(rid); routeIds.push(rid); }
              }
            }
            if (routeIds.length === 0) return;
            const shapeId = shapeIds[0];
            if (routeIds.length === 1) {
              const canonical = lookupRoute(activeId, routeIds[0])?.canonicalId ?? null;
              useAppStore.getState().setInspectorRoute({ feedId: activeId, rawId: routeIds[0], shapeId, canonicalId: canonical });
            } else {
              useAppStore.getState().setInspectorSegment({ feedId: activeId, shapeId, routeIds });
            }
          })
          .catch((err) => console.warn('shape→route resolve failed', err));
      });

      map.on('mouseenter', 'analysis-frequency-line', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'analysis-frequency-line', () => {
        map.getCanvas().style.cursor = '';
      });
      map.on('click', 'analysis-frequency-line', (evt) => {
        const feature = evt.features?.[0];
        if (!feature) return;
        const activeId = useAppStore.getState().activeFeedId;
        if (!activeId) return;
        const routeId = String(feature.properties?.route_id ?? '');
        if (!routeId) return;
        const canonical = lookupRoute(activeId, routeId)?.canonicalId ?? null;
        useAppStore.getState().setInspectorRoute({ feedId: activeId, rawId: routeId, shapeId: '', canonicalId: canonical });
      });

      map.on('click', (evt) => {
        const hit = map.queryRenderedFeatures(evt.point, {
          layers: ['stops-circle', 'shapes-line', 'analysis-frequency-line'],
        });
        if (hit.length === 0) {
          clearInspector();
        }
      });
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [setInspectorStop, setInspectorRoute, clearInspector, initialCamera]);

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
  // reuse stale geometry or stale diff results (used by diff mode's
  // `useDiffedShapes`, which this component no longer computes itself).
  useEffect(() => {
    const valid = new Set(feedOrder);
    for (const key of [...cacheRef.current.keys()]) {
      if (!valid.has(key)) {
        cacheRef.current.delete(key);
        dropShapeIndex(key);
        dropDiffCache(key);
        dropFeedFrequencyCache(key);
        dropFeedGueteklassenCache(key);
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
    map.setFilter('shapes-line-casing', modeFilter);
    map.setFilter('shapes-line', modeFilter);
  }, [showStops, modeVisibility, ready]);

  // Frequency analysis (no diff pair, so this is absolute trips/week rather
  // than a delta) — computed for whichever feed is active, so it also tracks
  // the timeline slider. Cached per feedId in `getOrComputeFeedFrequency`.
  const [feedFrequency, setFeedFrequency] = useState<FeedFrequencyResult | null>(null);
  useEffect(() => {
    if (analysisMode !== 'frequency' || !activeFeedId) {
      setFeedFrequency(null);
      return;
    }
    let cancelled = false;
    ensureFeedRender(activeFeedId)
      .then((entry) => {
        const routeIds = [...new Set([...entry.shapeToRoute.values()].flat())];
        return getOrComputeFeedFrequency(activeFeedId, routeIds);
      })
      .then((r) => { if (!cancelled) setFeedFrequency(r); })
      .catch((err) => console.warn('feed frequency compute failed', err));
    return () => { cancelled = true; };
  }, [analysisMode, activeFeedId, ensureFeedRender]);

  // Geometry (mode-colored) and frequency are mutually exclusive overlays,
  // same rule as the diff-mode map views — both trace the same shapes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const showingFrequency = analysisMode === 'frequency';
    map.setLayoutProperty('shapes-line', 'visibility', showingFrequency ? 'none' : 'visible');
    map.setLayoutProperty('shapes-line-casing', 'visibility', showingFrequency ? 'none' : 'visible');

    if (!showingFrequency || !activeFeedId || !feedFrequency || feedFrequency.feedId !== activeFeedId) {
      setSource(map, 'analysis-frequency', emptyFC());
      return;
    }
    setSource(map, 'analysis-frequency', feedFrequencyToGeoJSON(feedFrequency));
    setFeedFrequencySummary({
      feedId: feedFrequency.feedId,
      maxWeeklyTrips: feedFrequency.maxWeeklyTrips,
      scaleWeeklyTrips: feedFrequency.scaleWeeklyTrips,
      routeCount: feedFrequency.entries.length,
    });
  }, [analysisMode, activeFeedId, feedFrequency, ready, setFeedFrequencySummary]);

  // Population analysis — a fill layer under the routes/stops, so unlike
  // frequency it coexists with the normal geometry (no visibility toggling
  // needed here). Scoped to whatever bbox the map currently shows.
  const populationBounds = useMapBounds(mapRef, ready);
  const [feedPopulation, setFeedPopulation] = useState<FeedPopulationResult | null>(null);
  useEffect(() => {
    if (analysisMode !== 'population' || populationSource !== 'ghs' || !activeFeedId || !populationBounds) {
      setFeedPopulation(null);
      return;
    }
    const feed = useAppStore.getState().feeds[activeFeedId];
    if (!feed) { setFeedPopulation(null); return; }
    let cancelled = false;
    ensureFeedRender(activeFeedId).then((entry) => {
      if (cancelled) return;
      // The feed's full stops extent, not the current viewport — see the
      // `scaleBbox` comment in gtfs/population.ts. Falls back to the
      // viewport itself for a (stopless) feed with no computable bounds.
      const scaleBbox: Bbox = entry.bounds ? bboxFromBounds(entry.bounds) : populationBounds;
      return computeFeedPopulation(yearOfFeed(feed).year, populationBounds, scaleBbox);
    })
      .then((r) => { if (!cancelled && r) setFeedPopulation(r); })
      .catch((err) => console.warn('feed population compute failed', err));
    return () => { cancelled = true; };
  }, [analysisMode, populationSource, activeFeedId, populationBounds, ensureFeedRender]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (analysisMode !== 'population' || populationSource !== 'ghs' || !feedPopulation) {
      setFeedPopulationSummary(null);
      setSource(map, 'analysis-population', emptyFC());
      return;
    }
    setSource(map, 'analysis-population', feedPopulationToGeoJSON(feedPopulation));
    setFeedPopulationSummary({
      year: feedPopulation.summary.year,
      maxPopulation: feedPopulation.summary.maxPopulation,
      scalePopulation: feedPopulation.summary.scalePopulation,
      cellCount: feedPopulation.summary.cellCount,
      cellSizeMeters: feedPopulation.summary.cellSizeMeters,
    });
  }, [analysisMode, populationSource, feedPopulation, ready, setFeedPopulationSummary]);

  // Zählsprengel source: same fill layer/source as GHS-POP (both key off
  // `pop_norm`), just a different data provider and no feed-year dependency
  // — see gtfs/zaehlsprengel.ts.
  const [zaehlsprengelPopulation, setZaehlsprengelPopulation] = useState<ZaehlsprengelResult | null>(null);
  useEffect(() => {
    if (analysisMode !== 'population' || populationSource !== 'zsp' || !activeFeedId || !populationBounds) {
      setZaehlsprengelPopulation(null);
      return;
    }
    let cancelled = false;
    ensureFeedRender(activeFeedId).then((entry) => {
      if (cancelled) return;
      const scaleBbox: Bbox = entry.bounds ? bboxFromBounds(entry.bounds) : populationBounds;
      return getOrComputeZaehlsprengelPopulation(populationBounds, scaleBbox);
    })
      .then((r) => { if (!cancelled && r) setZaehlsprengelPopulation(r); })
      .catch((err) => console.warn('zählsprengel population fetch failed', err));
    return () => { cancelled = true; };
  }, [analysisMode, populationSource, activeFeedId, populationBounds, ensureFeedRender]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (analysisMode !== 'population' || populationSource !== 'zsp' || !zaehlsprengelPopulation) {
      setZaehlsprengelPopulationSummary(null);
      setSource(map, 'analysis-population', emptyFC());
      return;
    }
    setSource(map, 'analysis-population', zaehlsprengelPopulation.geojson);
    setZaehlsprengelPopulationSummary(zaehlsprengelPopulation.summary);
  }, [analysisMode, populationSource, zaehlsprengelPopulation, ready, setZaehlsprengelPopulationSummary]);

  // ÖV-Güteklassen analysis — a fill layer under routes/stops like population,
  // scoped to the current viewport (see gtfs/gueteklassen.ts).
  const [feedGueteklassen, setFeedGueteklassen] = useState<FeedGueteklassenResult | null>(null);
  useEffect(() => {
    if (analysisMode !== 'gueteklassen' || !activeFeedId || !populationBounds) {
      setFeedGueteklassen(null);
      return;
    }
    let cancelled = false;
    computeFeedGueteklassen(activeFeedId, populationBounds)
      .then((r) => { if (!cancelled) setFeedGueteklassen(r); })
      .catch((err) => console.warn('feed gueteklassen compute failed', err));
    return () => { cancelled = true; };
  }, [analysisMode, activeFeedId, populationBounds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (analysisMode !== 'gueteklassen' || !feedGueteklassen) {
      setFeedGueteklassenSummary(null);
      setSource(map, 'analysis-gueteklassen', emptyFC());
      return;
    }
    setSource(map, 'analysis-gueteklassen', feedGueteklassenToGeoJSON(feedGueteklassen));
    setFeedGueteklassenSummary(feedGueteklassen.summary);
  }, [analysisMode, feedGueteklassen, ready, setFeedGueteklassenSummary]);

  // Basemap style + era-matched Wayback satellite, shared with the diff views.
  const basemapYear = useAppStore((s) =>
    s.activeFeedId && s.feeds[s.activeFeedId] ? yearOfFeed(s.feeds[s.activeFeedId]).year : null,
  );
  useBasemap(mapRef, ready, basemapYear, 'shapes-line-casing');

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

  // Drive amber halo rings for all pinned entities.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (pinnedEntities.length === 0 || !registrySnapshot) {
      setSource(map, 'pinned-stops', emptyFC());
      return;
    }
    const features: GeoJSON.Feature[] = [];
    for (const pin of pinnedEntities) {
      if (pin.kind !== 'stop') continue;
      const canon = registrySnapshot.stops[pin.canonicalId];
      if (!canon) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [canon.lon, canon.lat] },
        properties: { canonicalId: pin.canonicalId },
      });
    }
    setSource(map, 'pinned-stops', { type: 'FeatureCollection', features });
  }, [pinnedEntities, registrySnapshot, ready]);

  // Highlight the inspected stop with an amber ring.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!inspectorStop) { setSource(map, 'inspector-stop', emptyFC()); return; }
    const render = cacheRef.current.get(inspectorStop.feedId);
    if (!render) { setSource(map, 'inspector-stop', emptyFC()); return; }
    const feature = render.stops.features.find(
      (f) => f.properties?.stop_id === inspectorStop.rawId,
    );
    setSource(map, 'inspector-stop', feature
      ? { type: 'FeatureCollection', features: [feature] }
      : emptyFC());
  }, [inspectorStop, ready]);

  // Highlight all shapes belonging to the inspected route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!inspectorRoute) { setSource(map, 'inspector-shape', emptyFC()); return; }
    const render = cacheRef.current.get(inspectorRoute.feedId);
    if (!render) { setSource(map, 'inspector-shape', emptyFC()); return; }
    const features = render.shapes.features.filter((f) => {
      const sid = String(f.properties?.shape_id ?? '');
      return render.shapeToRoute.get(sid)?.includes(inspectorRoute.rawId) ?? false;
    });
    setSource(map, 'inspector-shape', { type: 'FeatureCollection', features });
  }, [inspectorRoute, ready]);

  // Highlight stops served by the inspected route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!inspectorRoute) { setSource(map, 'inspector-route-stops', emptyFC()); return; }
    let cancelled = false;
    // Derive the route's primary mode from the first matching shape so dots
    // are mode-colored rather than a flat white.
    const render = cacheRef.current.get(inspectorRoute.feedId);
    const shapeFeature = render?.shapes.features.find((f) => {
      const sid = String(f.properties?.shape_id ?? '');
      return render!.shapeToRoute.get(sid)?.includes(inspectorRoute.rawId) ?? false;
    });
    const routeMode = String(shapeFeature?.properties?.primary_mode ?? 'other');
    getRouteDirections(inspectorRoute.feedId, inspectorRoute.rawId)
      .then((directions) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const features: GeoJSON.Feature[] = [];
        for (const dir of directions) {
          for (const s of dir.stops) {
            if (seen.has(s.stop_id)) continue;
            seen.add(s.stop_id);
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
              properties: { stop_id: s.stop_id, primary_mode: routeMode },
            });
          }
        }
        setSource(map, 'inspector-route-stops', { type: 'FeatureCollection', features });
      })
      .catch((err) => console.warn('inspector-route-stops failed', err));
    return () => { cancelled = true; };
  }, [inspectorRoute, ready]);

  const toggleModeVisibility = useAppStore((s) => s.toggleModeVisibility);

  return (
    <>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="map-mode-legend">
        {analysisMode === 'frequency' ? (
          <FrequencyLegend />
        ) : analysisMode === 'population' ? (
          <PopulationLegend />
        ) : analysisMode === 'gueteklassen' ? (
          <GueteklassenLegend />
        ) : (
          MODES.map((m) => (
            <label key={m} className={`diff-count ${modeVisibility[m] ? 'on' : 'off'}`}>
              <input
                type="checkbox"
                checked={modeVisibility[m]}
                onChange={() => toggleModeVisibility(m)}
              />
              <span className="diff-count-swatch" style={{ background: MODE_COLOR[m] }} />
              <span className="diff-count-label">{MODE_LABEL[m]}</span>
            </label>
          ))
        )}
      </div>
      <MapOverlay />
      <BasemapControls />
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

/** `boundsOfStops`/`ensureFeedRender`'s `entry.bounds` is always this concrete
 * SW/NE-corner shape (never another `LngLatBoundsLike` variant), so this
 * narrows it back to a flat `Bbox` for the population-scale callers. */
function bboxFromBounds(bounds: maplibregl.LngLatBoundsLike): Bbox {
  const b = bounds as [[number, number], [number, number]];
  return [b[0][0], b[0][1], b[1][0], b[1][1]];
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
