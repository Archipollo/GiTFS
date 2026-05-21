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
import { getRoutesForShape, getRouteDirections } from '../inspector/data';

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

const CARTO_ATTR = '© OpenStreetMap contributors, © CARTO';
const CARTO_TILES = (style: string) => [
  `https://a.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://b.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://c.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://d.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
];

// --- Esri World Imagery Wayback (historical satellite basemap) --------------
// ItemIds derived from the public WMTS capabilities XML; one mid-year snapshot
// per calendar year. The tile service itself has no CORS restriction.

const WAYBACK_BY_YEAR: Record<number, number> = {
  2014: 3026,
  2015: 24007,
  2016: 13240,
  2017: 3319,
  2018: 14829,
  2019: 16681,
  2020: 18289,
  2021: 8432,
  2022: 13851,
  2023: 47963,
  2024: 39767,
  2025: 49999,
  2026: 49059,
};

function waybackItemIdForYear(year: number): number {
  if (year in WAYBACK_BY_YEAR) return WAYBACK_BY_YEAR[year];
  // Clamp to the nearest known year
  const years = Object.keys(WAYBACK_BY_YEAR).map(Number).sort((a, b) => a - b);
  if (year <= years[0]) return WAYBACK_BY_YEAR[years[0]];
  if (year >= years[years.length - 1]) return WAYBACK_BY_YEAR[years[years.length - 1]];
  // Linear interpolation — pick the closest
  let closest = years[0];
  for (const y of years) {
    if (Math.abs(y - year) < Math.abs(closest - year)) closest = y;
  }
  return WAYBACK_BY_YEAR[closest];
}

const WAYBACK_TILES = (itemId: number) => [
  `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${itemId}/{z}/{y}/{x}`,
];
// Inverted lookup: itemId → year, so the attribution reflects the actual
// snapshot year loaded rather than the feed's nominal year.
const YEAR_BY_WAYBACK_ITEM: Record<number, number> = Object.fromEntries(
  Object.entries(WAYBACK_BY_YEAR).map(([yr, id]) => [id, Number(yr)]),
);
const waybackAttr = (itemId: number) =>
  `©${YEAR_BY_WAYBACK_ITEM[itemId] ?? '?'} Esri, Maxar, Earthstar Geographics, USGS`;
 
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap_standard: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
    basemap_voyager: {
      type: 'raster',
      tiles: CARTO_TILES('voyager'),
      tileSize: 256,
      attribution: CARTO_ATTR,
      maxzoom: 19,
    },
    basemap_dark: {
      type: 'raster',
      tiles: CARTO_TILES('dark_all'),
      tileSize: 256,
      attribution: CARTO_ATTR,
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'basemap_standard', type: 'raster', source: 'basemap_standard' },
    { id: 'basemap_voyager', type: 'raster', source: 'basemap_voyager', layout: { visibility: 'none' } },
    { id: 'basemap_dark', type: 'raster', source: 'basemap_dark', layout: { visibility: 'none' } },
  ],
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
  const inspectorStop = useAppStore((s) => s.inspectorStop);
  const inspectorRoute = useAppStore((s) => s.inspectorRoute);
  const registrySnapshot = useRegistry();
  const registryFocus = useAppStore((s) => s.registryFocus);
  const pinnedEntities = useAppStore((s) => s.pinnedEntities);

  // Diff mode plumbing -----------------------------------------------------
  const mapStyle = useAppStore((s) => s.mapStyle);
  const historicalBasemap = useAppStore((s) => s.historicalBasemap);
  const setHistoricalBasemap = useAppStore((s) => s.setHistoricalBasemap);
  const appMode = useAppStore((s) => s.mode);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffStopVisibility = useAppStore((s) => s.diffStopVisibility);
  const diffSegmentVisibility = useAppStore((s) => s.diffSegmentVisibility);
  const setDiffSegmentSummary = useAppStore((s) => s.setDiffSegmentSummary);
  const diffStopFocus = useAppStore((s) => s.diffStopFocus);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const diffBasemapYear = useAppStore((s) => s.diffBasemapYear);
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
  // Tracks which Wayback itemId is currently loaded as the historical basemap.
  const waybackItemIdRef = useRef<number | null>(null);

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
      map.addSource('pinned-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-route-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-stop', { type: 'geojson', data: emptyFC() });
      map.addSource('inspector-shape', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-segments', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-stops', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-ghost', { type: 'geojson', data: emptyFC() });
      map.addSource('diff-arrow', { type: 'geojson', data: emptyFC() });
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
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 4.5],
          'line-opacity': 0.40,
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
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 2.4],
          'line-opacity': 0.75,
        },
      });
      map.addLayer({
        id: 'diff-segments-removed-casing',
        type: 'line',
        source: 'diff-segments',
        filter: ['==', ['get', 'geom_status'], 'removed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.0, 14, 6.0],
          'line-opacity': 0.70,
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
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
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
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.0, 14, 6.0],
          'line-opacity': 0.70,
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
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
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
          'circle-opacity': 0.30,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 0.8,
          'circle-stroke-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'diff-stops-circle',
        type: 'circle',
        source: 'diff-stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 5.5],
          'circle-color': DIFF_COLOR_EXPR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 1.8],
          'circle-opacity': [
            'case',
            ['==', ['get', 'status'], 'unchanged'], 0.55,
            0.95,
          ],
          'circle-stroke-opacity': [
            'case',
            ['==', ['get', 'status'], 'unchanged'], 0.45,
            0.90,
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
            const appMode = useAppStore.getState().mode;
            const shapeId = shapeIds[0];
            if (appMode === 'diff') {
              const canonical = lookupRoute(activeId, routeIds[0])?.canonicalId ?? null;
              if (canonical) useAppStore.getState().setDiffRouteFocus(canonical);
            } else if (routeIds.length === 1) {
              const canonical = lookupRoute(activeId, routeIds[0])?.canonicalId ?? null;
              useAppStore.getState().setInspectorRoute({ feedId: activeId, rawId: routeIds[0], shapeId, canonicalId: canonical });
            } else {
              useAppStore.getState().setInspectorSegment({ feedId: activeId, shapeId, routeIds });
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
    map.setFilter('shapes-line-casing', modeFilter);
    map.setFilter('shapes-line', modeFilter);

    // Segment diff layers keep only their geom_status predicate here —
    // mode filtering is applied at GeoJSON emit time (see the `accept`
    // in the diff-segments effect) so the sidebar length totals stay
    // consistent with what's actually drawn.
  }, [showStops, modeVisibility, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // When historical basemap is active all base tile layers are hidden in
    // favour of the Wayback satellite layer (managed by the effect below).
    map.setLayoutProperty('basemap_standard', 'visibility', !historicalBasemap && mapStyle === 'standard' ? 'visible' : 'none');
    map.setLayoutProperty('basemap_voyager', 'visibility', !historicalBasemap && mapStyle === 'voyager' ? 'visible' : 'none');
    map.setLayoutProperty('basemap_dark', 'visibility', !historicalBasemap && mapStyle === 'dark' ? 'visible' : 'none');
  }, [mapStyle, historicalBasemap, ready]);

  // In standard mode: swap in era-appropriate Wayback satellite tiles when a feed
  // is active (hiding OSM), and fall back to OSM when no feed is loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const removeWayback = () => {
      if (waybackItemIdRef.current === null) return;
      if (map.getLayer('basemap_historical')) map.removeLayer('basemap_historical');
      if (map.getSource('basemap_historical')) map.removeSource('basemap_historical');
      waybackItemIdRef.current = null;
    };

    if (!historicalBasemap || !activeFeedId) {
      removeWayback();
      return;
    }

    const feedMeta = useAppStore.getState().feeds[activeFeedId];
    if (!feedMeta) return;
    // In diff mode use the explicit basemap-year override when set; otherwise
    // fall back to feed A's year (same behaviour as timeline mode).
    const baseFeedYear = yearOfFeed(feedMeta);
    const year = (appMode === 'diff' && diffBasemapYear != null)
      ? diffBasemapYear
      : baseFeedYear.year;
    const itemId = waybackItemIdForYear(year);

    if (waybackItemIdRef.current !== itemId) {
      if (map.getLayer('basemap_historical')) map.removeLayer('basemap_historical');
      if (map.getSource('basemap_historical')) map.removeSource('basemap_historical');
      map.addSource('basemap_historical', {
        type: 'raster',
        tiles: WAYBACK_TILES(itemId),
        tileSize: 256,
        attribution: waybackAttr(itemId),
        maxzoom: 17,
      });
      map.addLayer(
        { id: 'basemap_historical', type: 'raster', source: 'basemap_historical' },
        'shapes-line-casing',
      );
      waybackItemIdRef.current = itemId;
    }
  }, [historicalBasemap, activeFeedId, appMode, diffBasemapYear, ready]);

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

  // Highlight the inspected stop with an amber ring (timeline mode only;
  // diff mode is driven by the diffStopFocus effect below).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (appMode === 'diff') return;
    if (!inspectorStop) { setSource(map, 'inspector-stop', emptyFC()); return; }
    const render = cacheRef.current.get(inspectorStop.feedId);
    if (!render) { setSource(map, 'inspector-stop', emptyFC()); return; }
    const feature = render.stops.features.find(
      (f) => f.properties?.stop_id === inspectorStop.rawId,
    );
    setSource(map, 'inspector-stop', feature
      ? { type: 'FeatureCollection', features: [feature] }
      : emptyFC());
  }, [inspectorStop, ready, appMode]);

  // Highlight all shapes belonging to the inspected route (timeline mode only).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (appMode === 'diff') return;
    if (!inspectorRoute) { setSource(map, 'inspector-shape', emptyFC()); return; }
    const render = cacheRef.current.get(inspectorRoute.feedId);
    if (!render) { setSource(map, 'inspector-shape', emptyFC()); return; }
    const features = render.shapes.features.filter((f) => {
      const sid = String(f.properties?.shape_id ?? '');
      return render.shapeToRoute.get(sid)?.includes(inspectorRoute.rawId) ?? false;
    });
    setSource(map, 'inspector-shape', { type: 'FeatureCollection', features });
  }, [inspectorRoute, ready, appMode]);

  // Highlight stops served by the inspected route (timeline mode only).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (appMode === 'diff') return;
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
  }, [inspectorRoute, ready, appMode]);

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
    // The base shapes layers would duplicate (and recolor) the diff polylines
    // in diff mode, so we hide them completely rather than just dimming.
    map.setLayoutProperty(
      'shapes-line-casing',
      'visibility',
      showDiffOverlay ? 'none' : 'visible',
    );
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

  // Fly to and highlight the focused diff stop (amber halo, same as timeline mode).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffStopFocus || diffStatus.kind !== 'ready') {
      setSource(map, 'inspector-stop', emptyFC());
      return;
    }
    const entry = diffStatus.result.stops.find((e) => e.canonicalId === diffStopFocus);
    if (!entry) { setSource(map, 'inspector-stop', emptyFC()); return; }
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
    setSource(map, 'inspector-stop', {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coord },
        properties: {},
      }],
    });
  }, [diffStopFocus, diffStatus, ready]);

  // Highlight shapes from both feeds and fit bounds for the focused diff route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!diffRouteFocus || diffStatus.kind !== 'ready' || !registrySnapshot) {
      setSource(map, 'inspector-shape', emptyFC());
      setSource(map, 'inspector-route-stops', emptyFC());
      return;
    }
    const entry = diffStatus.result.routes.find(
      (e) => e.canonicalId === diffRouteFocus,
    );
    if (!entry) {
      setSource(map, 'inspector-shape', emptyFC());
      setSource(map, 'inspector-route-stops', emptyFC());
      return;
    }
    const fromCid = entry.renumbering
      ? entry.renumbering.fromCanonicalId
      : entry.canonicalId;
    const toCid = entry.renumbering
      ? entry.renumbering.toCanonicalId
      : entry.canonicalId;

    const aRender = cacheRef.current.get(diffStatus.feedA);
    const bRender = cacheRef.current.get(diffStatus.feedB);
    const coords: [number, number][] = [];
    const shapeFeatures: GeoJSON.Feature[] = [];
    const collectShapes = (
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
        if (!hit) continue;
        coords.push(...shape.coords);
        shapeFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: shape.coords },
          properties: { shape_id: shape.shape_id },
        });
      }
    };
    collectShapes(aRender, diffStatus.feedA, fromCid);
    collectShapes(bRender, diffStatus.feedB, toCid);

    setSource(map, 'inspector-shape', { type: 'FeatureCollection', features: shapeFeatures });

    if (coords.length > 0) {
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
    }

    // Collect stops served by the focused route on both sides.
    // Derive mode from the first collected shape so dots are mode-colored.
    const routeMode = String(shapeFeatures[0]?.properties?.primary_mode ?? 'other');
    let cancelled = false;
    const aRawIds = (registrySnapshot.routeMembers[fromCid] ?? [])
      .filter((m) => m.feedId === diffStatus.feedA).map((m) => m.rawId);
    const bRawIds = (registrySnapshot.routeMembers[toCid] ?? [])
      .filter((m) => m.feedId === diffStatus.feedB).map((m) => m.rawId);
    Promise.all([
      ...aRawIds.map((id) => getRouteDirections(diffStatus.feedA, id)),
      ...bRawIds.map((id) => getRouteDirections(diffStatus.feedB, id)),
    ])
      .then((allDirs) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const features: GeoJSON.Feature[] = [];
        for (const dirs of allDirs) {
          for (const dir of dirs) {
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
        }
        setSource(map, 'inspector-route-stops', { type: 'FeatureCollection', features });
      })
      .catch((err) => console.warn('diff inspector-route-stops failed', err));
    return () => { cancelled = true; };
  }, [diffRouteFocus, diffStatus, registrySnapshot, ready]);

  const setMapStyle = useAppStore((s) => s.setMapStyle);

  return (
    <>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <MapOverlay />
      <button
        className="map-basemap-toggle"
        title={
          mapStyle === 'standard' ? 'Switch to light map (Voyager)' :
          mapStyle === 'voyager' ? 'Switch to dark map' :
          'Switch to standard map (OSM)'
        }
        onClick={() =>
          setMapStyle(
            mapStyle === 'standard' ? 'voyager' :
            mapStyle === 'voyager' ? 'dark' :
            'standard',
          )
        }
      >
        {mapStyle === 'standard' ? '◑' : mapStyle === 'voyager' ? '○' : '●'}
      </button>
      <button
        className={`map-basemap-toggle map-historical-toggle${historicalBasemap ? ' active' : ''}`}
        title={historicalBasemap ? 'Disable historical satellite basemap' : 'Enable historical satellite basemap'}
        onClick={() => setHistoricalBasemap(!historicalBasemap)}
      >
        <i className="fa-solid fa-satellite" />
      </button>
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
