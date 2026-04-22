import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, {
  Map as MapLibreMap,
  type ExpressionSpecification,
  type FilterSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../state/app-store';
import { fetchStops, fetchShapes, type StopPoint, type ShapePolyline } from '../gtfs/queries';
import { MODES, MODE_COLOR, type Mode } from '../gtfs/modes';
import MapOverlay from './MapOverlay';
import { useRegistry } from '../registry/useRegistry';
import { lookupStop } from '../registry/registry';

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
  const setInspectorSelection = useAppStore((s) => s.setInspectorSelection);
  const registrySnapshot = useRegistry();
  const registryFocus = useAppStore((s) => s.registryFocus);

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
      const [stops, shapes] = await Promise.all([
        fetchStops(feedId),
        fetchShapes(feedId),
      ]);
      const entry: FeedRender = {
        stops: stopsToGeoJSON(stops),
        shapes: shapesToGeoJSON(shapes),
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
        const rawId = String(props.stop_id ?? '');
        const canonical = activeId ? lookupStop(activeId, rawId)?.canonicalId ?? null : null;
        setInspectorSelection({
          kind: 'stop',
          stopId: rawId,
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
        setInspectorSelection({
          kind: 'line',
          shapeId: String(props.shape_id ?? ''),
          modes: modesFromProps(props),
        });
      });

      map.on('click', (evt) => {
        const hit = map.queryRenderedFeatures(evt.point, { layers: ['stops-circle', 'shapes-line'] });
        if (hit.length === 0) setInspectorSelection(null);
      });
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [setInspectorSelection]);

  // Swap visible feed. Cache hit = instant setData, no spinner, no camera move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!activeFeedId) {
      setSource(map, 'stops', emptyFC());
      setSource(map, 'shapes', emptyFC());
      setInspectorSelection(null);
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
  }, [activeFeedId, ready, activeFeedLabel, beginMapTask, endMapTask, ensureFeedRender, setInspectorSelection]);

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

  // Drop cache entries for feeds the user has removed.
  useEffect(() => {
    const valid = new Set(feedOrder);
    for (const key of [...cacheRef.current.keys()]) {
      if (!valid.has(key)) cacheRef.current.delete(key);
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
