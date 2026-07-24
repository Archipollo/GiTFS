// Shared MapLibre bootstrap for the diff-mode map views (SplitMapView,
// RouteDetailView). Both mount independent `maplibregl.Map` instances that
// only ever draw pre-computed GeoJSON (diff segments / stops / frequency) —
// they never touch DuckDB directly, so having several live instances is
// cheap relative to the worker-side diff computation itself.

import maplibregl, { type Map as MapLibreMap, type PointLike } from 'maplibre-gl';
import { SEGMENT_COLOR, type GeomStatus } from '../gtfs/segment-graph';
import { DIFF_COLOR } from './geojson';
import type { StopStatus } from './engine';
import { basemapLayers, basemapSources } from '../map/basemap';
import { useAppStore } from '../state/app-store';
import {
  FREQUENCY_BIG_LOSS_COLOR,
  FREQUENCY_SMALL_LOSS_COLOR,
  FREQUENCY_NEUTRAL_COLOR,
  FREQUENCY_SMALL_GAIN_COLOR,
  FREQUENCY_BIG_GAIN_COLOR,
  FREQUENCY_CLASS_BREAKS,
} from './frequency';

/** First layer added by `addDiffSegmentLayers` — the anchor a dynamically
 * inserted basemap (historical satellite) must slot in *below*. This is the
 * focus glow (drawn beneath every status line), so a restored satellite still
 * sits under the whole diff stack. */
export const FIRST_DIFF_LAYER_ID = 'diff-segments-focus';

/**
 * Accent for the inspector-focused line/stop — a light tint of the GiTFS brand
 * blue (`--accent` `#2d6cdf`, the "Load feeds" button colour). It's drawn at
 * *full opacity* on purpose: the focused route's geometry has many overlapping
 * runs (both directions, plus `unchanged` emitted from both feeds), and a
 * translucent glow would compound its alpha where they overlap, making some
 * stretches glow harder than others. An opaque line over an opaque line is
 * identical to one line, so full opacity keeps the halo perfectly even; the
 * light tint is what keeps it subtle instead of intense. Blue also can't be
 * confused with any geometry status (green/red/gray/yellow).
 */
export const DIFF_FOCUS_COLOR = '#8fb3f0';

/**
 * Visibility records that hide nothing — for the focus glow/halo layers,
 * which must keep tracing the inspector-focused route/stop's geometry no
 * matter what the user has toggled off (status checkboxes) or which overlay
 * is active (frequency mode empties the regular `diff-segments`/`diff-stops`
 * sources those toggles gate; the focus layers read from their own always-on
 * sources instead, see `diff-segments-focus-data`/`diff-stops-focus-data`).
 */
export const ALL_SEGMENT_STATUSES_VISIBLE: Record<GeomStatus, boolean> = {
  added: true, removed: true, unchanged: true, changed: true,
};
export const ALL_STOP_STATUSES_VISIBLE: Record<StopStatus, boolean> = {
  added: true, removed: true, moved: true, renamed: true, unchanged: true,
};

/** MapLibre filter that matches nothing — the "no focus" state for a highlight layer. */
const MATCH_NONE: maplibregl.FilterSpecification = ['==', ['literal', 1], ['literal', 0]];

/** Point a highlight layer's filter at a single id, or hide it entirely when `id` is null. */
function focusFilter(prop: string, id: string | null): maplibregl.FilterSpecification {
  return id ? ['==', ['get', prop], id] : MATCH_NONE;
}

/**
 * Highlight the focused route's runs (keyed on `canonical_id`); pass `null` to
 * clear. When `directionId` is given, the glow is additionally scoped to that
 * direction's runs (see the inspector's per-direction focus) instead of the
 * whole line.
 */
export function setDiffRouteHighlight(
  map: MapLibreMap,
  canonicalId: string | null,
  directionId?: number | null,
): void {
  if (!map.getLayer('diff-segments-focus')) return;
  if (!canonicalId) {
    map.setFilter('diff-segments-focus', MATCH_NONE);
    return;
  }
  const filter: maplibregl.FilterSpecification = directionId == null
    ? ['==', ['get', 'canonical_id'], canonicalId]
    : ['all', ['==', ['get', 'canonical_id'], canonicalId], ['==', ['get', 'direction_id'], directionId]];
  map.setFilter('diff-segments-focus', filter);
}

/** Highlight the focused stop's dot (keyed on `canonicalId`); pass `null` to clear. */
export function setDiffStopHighlight(map: MapLibreMap, canonicalId: string | null): void {
  if (map.getLayer('diff-stop-focus-halo')) {
    map.setFilter('diff-stop-focus-halo', focusFilter('canonicalId', canonicalId));
  }
}

/**
 * A fresh style object per call — MapLibre mutates the style spec it's
 * given while loading, so two map instances must never share the same
 * object reference (SplitMapView mounts two concurrently; sharing one
 * literal here left both stuck with `isStyleLoaded() === false` forever).
 *
 * Carries all four selectable basemaps; `useBasemap` toggles their visibility.
 */
export function createDiffMapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    // The raster basemap ships no fonts; station-name labels (a `text-field`
    // symbol layer) need a glyphs endpoint. OpenFreeMap serves real protobuf
    // glyphs for `Noto Sans Regular` (application/x-protobuf, CORS *) — the old
    // fonts.openmaptiles.org path now returns an HTML landing page, which made
    // the symbol layer fail glyph loading and take the shared-source stop dots
    // down with it at labelMinZoom. Consistent with the app already streaming
    // its tiles from external CDNs — there's no offline guarantee to preserve.
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: basemapSources(),
    layers: basemapLayers(useAppStore.getState().mapStyle),
  };
}

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

export function setSource(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection): void {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
}

/**
 * Local-planar (equirectangular) point-to-segment distance in metres.
 * Accurate enough at route/stop scale (a few km) without haversine's cost.
 */
function pointToSegmentDistM(
  plon: number, plat: number,
  alon: number, alat: number,
  blon: number, blat: number,
): number {
  const dLat = 111320;
  const dLon = 111320 * Math.cos((plat * Math.PI) / 180);
  const px = plon * dLon, py = plat * dLat;
  const ax = alon * dLon, ay = alat * dLat;
  const bx = blon * dLon, by = blat * dLat;
  const abx = bx - ax, aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function nearestDistToRunsM(
  lon: number, lat: number,
  runs: readonly { coords: readonly (readonly [number, number])[] }[],
): number {
  let best = Infinity;
  for (const run of runs) {
    const c = run.coords;
    for (let i = 1; i < c.length; i++) {
      const d = pointToSegmentDistM(lon, lat, c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Restricts a stop/arrow FeatureCollection to features within `toleranceM`
 * of a route's own shape runs. Stop-diff entries don't carry a route id
 * (see `diffStopPoints`), so the detail view approximates "this route's
 * stops" geometrically instead of via a new stop<->route join query.
 */
export function filterFeaturesNearRoute(
  fc: GeoJSON.FeatureCollection,
  runs: readonly { coords: readonly (readonly [number, number])[] }[],
  toleranceM: number,
): GeoJSON.FeatureCollection {
  if (!runs.length) return emptyFC();
  return {
    type: 'FeatureCollection',
    features: fc.features.filter((f) => {
      if (f.geometry.type === 'Point') {
        const [lon, lat] = f.geometry.coordinates as [number, number];
        return nearestDistToRunsM(lon, lat, runs) <= toleranceM;
      }
      if (f.geometry.type === 'LineString') {
        return f.geometry.coordinates.some(
          ([lon, lat]) => nearestDistToRunsM(lon, lat, runs) <= toleranceM,
        );
      }
      return false;
    }),
  };
}

/** Bounding box of every coordinate in a FeatureCollection's LineString/MultiLineString
 * geometries, or `null` if empty. */
export function boundsOfLineFeatures(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBoundsLike | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const grow = ([lon, lat]: GeoJSON.Position) => {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  for (const feature of fc.features) {
    if (feature.geometry.type === 'LineString') {
      feature.geometry.coordinates.forEach(grow);
    } else if (feature.geometry.type === 'MultiLineString') {
      feature.geometry.coordinates.forEach((line) => line.forEach(grow));
    }
  }
  if (minLon === Infinity) return null;
  return [[minLon, minLat], [maxLon, maxLat]];
}

// ---- Direction chevrons --------------------------------------------
//
// Adapted from MOTIS's itinerary rendering, which marks direction of travel
// with repeating '›' glyphs along the line (`symbol-placement: 'line'`,
// `text-keep-upright: false`). We can't reuse their text-based layer: that
// needs a `glyphs` URL in the style, and `createDiffMapStyle` is a
// raster-only basemap with no font stack — a `text-field` layer would
// silently render nothing. Instead each status gets a small pre-tinted
// chevron drawn on a canvas and registered with `map.addImage`, used via
// `icon-image`. This also keeps the app free of an external font
// dependency, which matters for a no-backend, client-side-only build.
//
// Chevrons follow shape vertex order, and GTFS `shapes.txt` is ordered in
// the direction of travel — so no extra data is needed to orient them.

/** Darken a `#rrggbb` hex by `amount` (0..1), MOTIS's `getDecorativeColors` trick
 *  without pulling in `colord`. Chevrons need to read *against* the line they
 *  sit on, not blend into it. */
function darkenHex(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = 1 - amount;
  const r = Math.round(((n >> 16) & 0xff) * f);
  const g = Math.round(((n >> 8) & 0xff) * f);
  const b = Math.round((n & 0xff) * f);
  return `rgb(${r},${g},${b})`;
}

const CHEVRON_IMAGE_PREFIX = 'diff-chevron-';

/** Canvas-drawn '›' chevron, tinted `color`, at 2x for retina crispness. */
function chevronImage(color: string): ImageData | null {
  const px = 2;
  const size = 12;
  const canvas = document.createElement('canvas');
  canvas.width = size * px;
  canvas.height = size * px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(px, px);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(4.5, 3);
  ctx.lineTo(8, 6);
  ctx.lineTo(4.5, 9);
  ctx.stroke();
  return ctx.getImageData(0, 0, size * px, size * px);
}

/** Register one chevron icon per geometry status. Safe to call repeatedly. */
function addChevronImages(map: MapLibreMap): void {
  for (const [status, color] of Object.entries(SEGMENT_COLOR)) {
    const id = `${CHEVRON_IMAGE_PREFIX}${status}`;
    if (map.hasImage(id)) continue;
    const img = chevronImage(darkenHex(color, 0.35));
    if (img) map.addImage(id, img, { pixelRatio: 2 });
  }
}

/** Diff-segment (line geometry) source + layers — the shared geometry-diff visual language. */
export function addDiffSegmentLayers(map: MapLibreMap): void {
  map.addSource('diff-segments', { type: 'geojson', data: emptyFC() });
  // Always carries the focused route's full geometry (every status, every
  // side), independent of the status checkboxes and of `analysisMode` — so
  // switching into frequency view (which empties `diff-segments`) doesn't
  // also erase the glow. Populated via `setSource(map, 'diff-segments-focus-data', ...)`
  // by the view components, using `ALL_SEGMENT_STATUSES_VISIBLE`.
  map.addSource('diff-segments-focus-data', { type: 'geojson', data: emptyFC() });
  addChevronImages(map);

  // Soft blue glow beneath every status line, tracing the inspector-focused
  // route (filter set via `setDiffRouteHighlight`; matches nothing until then).
  // Kept at the bottom of the diff stack so the status colours draw on top and
  // the glow only peeks out as a halo — subtle, not a recolour. Must stay the
  // first diff layer: `FIRST_DIFF_LAYER_ID` points here so the satellite
  // basemap slots in below the whole stack.
  map.addLayer({
    id: 'diff-segments-focus',
    type: 'line',
    source: 'diff-segments-focus-data',
    filter: MATCH_NONE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': DIFF_FOCUS_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 12],
      // Full opacity — see DIFF_FOCUS_COLOR: a translucent glow compounds where
      // the route's overlapping runs stack, making some stretches glow harder.
      // Opaque keeps it even; the light tint keeps it subtle.
      'line-opacity': 1,
      'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3],
    },
  });

  map.addLayer({
    id: 'diff-segments-unchanged-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['==', ['get', 'geom_status'], 'unchanged'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 2.4],
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 2.4],
      'line-opacity': 0.55,
    },
  });
  // 'removed'/'added' geometry is split by `line_status`: when the owning line
  // still exists in both feeds (`line_status == 'present'`) the dropped/new
  // stretch is a **reroute**, drawn yellow (dotted for old, solid for new) like
  // the paired `changed` runs — so red/green stay reserved for whole-line
  // removals/additions. The red/green layers match `!= 'present'` (covers both
  // `'removed'`/`'added'` and the `'none'` fallback), so a view that omits the
  // `lineStatus` projection fails safe to the plain colour instead of inverting.
  map.addLayer({
    id: 'diff-segments-removed-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'removed'], ['!=', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'diff-segments-removed-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'removed'], ['!=', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.removed,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.95,
    },
  });
  // Reroute — old geometry dropped from a surviving line: yellow dotted (mirrors changed/old).
  map.addLayer({
    id: 'diff-segments-reroute-removed-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'removed'], ['==', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'diff-segments-reroute-removed-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'removed'], ['==', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.changed,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-dasharray': [0, 2],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'diff-segments-added-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'added'], ['!=', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-added-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'added'], ['!=', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.added,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  // Reroute — new geometry added to a surviving line: yellow solid (mirrors changed/new).
  map.addLayer({
    id: 'diff-segments-reroute-added-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'added'], ['==', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-reroute-added-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'added'], ['==', ['get', 'line_status'], 'present']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.changed,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-changed-old-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'changed'], ['==', ['get', 'changed_side'], 'old']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-changed-old-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'changed'], ['==', ['get', 'changed_side'], 'old']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.changed,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-dasharray': [0, 2],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-changed-new-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'changed'], ['==', ['get', 'changed_side'], 'new']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-segments-changed-new-line',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'changed'], ['==', ['get', 'changed_side'], 'new']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': SEGMENT_COLOR.changed,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.55,
    },
  });

  // Direction-of-travel chevrons, drawn on top of every status. One layer
  // for all statuses (icon picked by `geom_status`) rather than one per
  // status, so symbol collision is resolved globally — otherwise chevrons
  // from overlapping runs would be placed independently and pile up.
  //
  // `unchanged` is emitted from both feeds for the same corridor (see
  // `segmentDiffToGeoJSON`); callers pass an `accept` predicate that keeps
  // only one copy, so no feed filter belongs here.
  map.addLayer({
    id: 'diff-segments-chevrons',
    type: 'symbol',
    source: 'diff-segments',
    minzoom: 11,
    layout: {
      'symbol-placement': 'line',
      // Sparse on purpose: chevrons only need to establish direction, and at
      // network scale a dense run of them reads as texture rather than arrows.
      'symbol-spacing': 200,
      // Reroute geometry (removed/added on a surviving line) uses the yellow
      // 'changed' chevron to match its yellow line; everything else keys on
      // its own geom_status (note unchanged runs are also 'present' — only
      // removed/added are rewritten).
      'icon-image': ['concat', CHEVRON_IMAGE_PREFIX, [
        'case',
        ['all',
          ['==', ['get', 'line_status'], 'present'],
          ['any', ['==', ['get', 'geom_status'], 'removed'], ['==', ['get', 'geom_status'], 'added']],
        ],
        'changed',
        ['get', 'geom_status'],
      ]],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 1],
      'icon-rotation-alignment': 'map',
      // Chevrons must follow the line's own direction even when it points
      // "backwards" on screen — that's the whole point of drawing them.
      'icon-keep-upright': false,
      'icon-allow-overlap': false,
      'icon-padding': 2,
    },
    paint: { 'icon-opacity': 0.9 },
  });
}

export const DIFF_SEGMENT_LINE_LAYERS = [
  'diff-segments-added-line',
  'diff-segments-removed-line',
  'diff-segments-reroute-removed-line',
  'diff-segments-reroute-added-line',
  'diff-segments-unchanged-line',
  'diff-segments-changed-old-line',
  'diff-segments-changed-new-line',
];

/**
 * Wires up click-to-focus on the diff-segment line layers: a map click
 * selects/highlights a route in the sidebar via `setDiffRouteFocus`, but
 * never jumps into the detail view — that's reserved for an explicit
 * sidebar-row click. Shared by SplitMapView and NetworkDiffMapView so the
 * ~20-line hit-testing logic isn't duplicated.
 */
export function attachDiffSegmentClickHandler(
  map: MapLibreMap,
  setDiffRouteFocus: (canonicalId: string, candidates: string[]) => void,
): void {
  for (const layerId of DIFF_SEGMENT_LINE_LAYERS) {
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', layerId, (evt) => {
      const f = evt.features?.[0];
      if (!f) return;
      const metersPerPixel =
        (156543.03392 * Math.cos((evt.lngLat.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
      const targetMeters = 8;
      const radiusPx = Math.min(4, Math.max(1, targetMeters / metersPerPixel));
      const bbox: [PointLike, PointLike] = [
        [evt.point.x - radiusPx, evt.point.y - radiusPx],
        [evt.point.x + radiusPx, evt.point.y + radiusPx],
      ];
      const allFeatures = map.queryRenderedFeatures(bbox, { layers: DIFF_SEGMENT_LINE_LAYERS });
      const candidates = [...new Set(
        allFeatures.map((feat) => String(feat.properties?.canonical_id ?? '')).filter(Boolean),
      )];
      const clickedCanonical = String(f.properties?.canonical_id ?? '') || candidates[0];
      if (!clickedCanonical) return;
      setDiffRouteFocus(clickedCanonical, candidates.length ? candidates : [clickedCanonical]);
    });
  }
}

/**
 * Wires up click-to-focus on the frequency-overlay line: same behaviour as
 * `attachDiffSegmentClickHandler` (select the route in the inspector without
 * jumping into the detail view), just keyed on the frequency layer's
 * `canonicalId` property instead of the segment layers' `canonical_id`.
 * Independent of the segment handler so a view can wire whichever overlay is
 * actually visible for the current `analysisMode`.
 */
export function attachDiffFrequencyClickHandler(
  map: MapLibreMap,
  setDiffRouteFocus: (canonicalId: string, candidates: string[]) => void,
): void {
  const layerId = 'diff-frequency-line';
  map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  map.on('click', layerId, (evt) => {
    const f = evt.features?.[0];
    if (!f) return;
    const metersPerPixel =
      (156543.03392 * Math.cos((evt.lngLat.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    const targetMeters = 8;
    const radiusPx = Math.min(4, Math.max(1, targetMeters / metersPerPixel));
    const bbox: [PointLike, PointLike] = [
      [evt.point.x - radiusPx, evt.point.y - radiusPx],
      [evt.point.x + radiusPx, evt.point.y + radiusPx],
    ];
    const allFeatures = map.queryRenderedFeatures(bbox, { layers: [layerId] });
    const candidates = [...new Set(
      allFeatures.map((feat) => String(feat.properties?.canonicalId ?? '')).filter(Boolean),
    )];
    const clickedCanonical = String(f.properties?.canonicalId ?? '') || candidates[0];
    if (!clickedCanonical) return;
    setDiffRouteFocus(clickedCanonical, candidates.length ? candidates : [clickedCanonical]);
  });
}

/**
 * Wires up click-to-inspect on the diff-stop dots: a click focuses the
 * clicked stop's canonical id via `setDiffStopFocus`, which drives the
 * DiffInspector's stop card. Shared by all three diff views (network, split,
 * route detail) so the small hit-testing block isn't duplicated. Mirrors
 * `attachDiffSegmentClickHandler`; the two are independent, so clicking a dot
 * that happens to sit on a line focuses the stop (and, if the line is also
 * under the point, its route) — the inspector shows both cards.
 */
export function attachDiffStopClickHandler(
  map: MapLibreMap,
  setDiffStopFocus: (canonicalId: string | null) => void,
): void {
  map.on('mouseenter', 'diff-stops-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'diff-stops-circle', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'diff-stops-circle', (evt) => {
    const f = evt.features?.[0];
    if (!f) return;
    const canonicalId = String(f.properties?.canonicalId ?? '');
    if (!canonicalId) return;
    setDiffStopFocus(canonicalId);
  });
}

/**
 * Diff-mode stop overlay (added/removed/moved/renamed dots + move arrows),
 * plus a station-name label layer beneath each dot.
 *
 * `labelMinZoom` gates when the names appear: the network overview passes a
 * mid-range zoom so labels only surface once the user zooms into an area,
 * while the focused route detail passes 0 to show them at any zoom (the map
 * is already scoped to one line there). Label visibility is additionally
 * toggled at the view layer via the `diff-stops-labels` layer's `visibility`.
 */
export function addDiffStopLayers(
  map: MapLibreMap,
  opts: { labelMinZoom?: number } = {},
): void {
  map.addSource('diff-stops', { type: 'geojson', data: emptyFC() });
  map.addSource('diff-ghost', { type: 'geojson', data: emptyFC() });
  map.addSource('diff-arrow', { type: 'geojson', data: emptyFC() });
  // Always carries every stop (all statuses), independent of the status
  // checkboxes — so the focused stop's halo survives both the "unchanged off
  // by default" default and frequency mode zeroing every status toggle.
  // Populated via `setSource(map, 'diff-stops-focus-data', ...)` by the view
  // components, using `ALL_STOP_STATUSES_VISIBLE`.
  map.addSource('diff-stops-focus-data', { type: 'geojson', data: emptyFC() });

  const DIFF_COLOR_EXPR: maplibregl.ExpressionSpecification = [
    'match',
    ['get', 'status'],
    'added', DIFF_COLOR.added,
    'removed', DIFF_COLOR.removed,
    'moved', DIFF_COLOR.moved,
    'renamed', DIFF_COLOR.renamed,
    'unchanged', DIFF_COLOR.unchanged,
    '#94a3b8',
  ];

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
  // Soft violet halo behind the inspector-focused stop (filter set via
  // `setDiffStopHighlight`; matches nothing until then). Drawn before the dot
  // layer so the status-coloured dot sits on top and the halo reads as an aura.
  map.addLayer({
    id: 'diff-stop-focus-halo',
    type: 'circle',
    source: 'diff-stops-focus-data',
    filter: MATCH_NONE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 15],
      'circle-color': DIFF_FOCUS_COLOR,
      // One halo per stop (no self-overlap), so opacity is even at any value;
      // kept fairly solid to match the light-tint line glow's weight.
      'circle-opacity': 0.85,
      'circle-blur': 0.5,
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
      'circle-opacity': 0.95,
      'circle-stroke-opacity': 0.90,
    },
  });
  // Station-name label beneath each dot (MOTIS-style). Prefer the current (B)
  // name, falling back to the old (A) name for removed stops. `minzoom` keeps
  // the network overview uncluttered; collision handling drops overlapping
  // labels rather than letting them pile up.
  map.addLayer({
    id: 'diff-stops-labels',
    type: 'symbol',
    source: 'diff-stops',
    minzoom: opts.labelMinZoom ?? 0,
    layout: {
      'text-field': ['coalesce', ['get', 'b_name'], ['get', 'a_name'], ''],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12.5],
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
      'text-max-width': 8,
      'text-optional': true,
      'text-allow-overlap': false,
      'text-padding': 2,
    },
    paint: {
      'text-color': '#1f2933',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4,
      'text-halo-blur': 0.3,
    },
  });
}

/** Frequency overlay source + layers, scoped to whatever features the caller passes in. */
export function addDiffFrequencyLayers(map: MapLibreMap): void {
  map.addSource('diff-frequency', { type: 'geojson', data: emptyFC() });
  const colorExpr: maplibregl.ExpressionSpecification = [
    'step', ['get', 'delta_norm'],
    FREQUENCY_BIG_LOSS_COLOR,
    FREQUENCY_CLASS_BREAKS[0], FREQUENCY_SMALL_LOSS_COLOR,
    FREQUENCY_CLASS_BREAKS[1], FREQUENCY_NEUTRAL_COLOR,
    FREQUENCY_CLASS_BREAKS[2], FREQUENCY_SMALL_GAIN_COLOR,
    FREQUENCY_CLASS_BREAKS[3], FREQUENCY_BIG_GAIN_COLOR,
  ];
  // Width now also encodes the *size* of the change (not just zoom): a route
  // near zero delta renders near the thin end regardless of zoom, while one
  // at or beyond the p95 cap renders near the thick end — so "how much more
  // or less frequented" reads directly off the line without a click.
  // MapLibre allows only one zoom-based interpolate per expression, and it
  // must be the top-level expression — so zoom is the outer interpolate,
  // magnitude the (zoom-free) inner one, and the casing's "+2px" offset is
  // baked into its own copy's stops rather than wrapped around the line's.
  const magnitudeWidthExpr: maplibregl.ExpressionSpecification = [
    'interpolate', ['linear'], ['zoom'],
    8, ['interpolate', ['linear'], ['abs', ['get', 'delta_norm']], 0, 1, 1, 2.2],
    14, ['interpolate', ['linear'], ['abs', ['get', 'delta_norm']], 0, 1.6, 1, 5.4],
  ];
  const magnitudeCasingWidthExpr: maplibregl.ExpressionSpecification = [
    'interpolate', ['linear'], ['zoom'],
    8, ['interpolate', ['linear'], ['abs', ['get', 'delta_norm']], 0, 3, 1, 4.2],
    14, ['interpolate', ['linear'], ['abs', ['get', 'delta_norm']], 0, 3.6, 1, 7.4],
  ];
  map.addLayer({
    id: 'diff-frequency-casing',
    type: 'line',
    source: 'diff-frequency',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': magnitudeCasingWidthExpr,
      'line-opacity': 0.55,
    },
  });
  map.addLayer({
    id: 'diff-frequency-line',
    type: 'line',
    source: 'diff-frequency',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': colorExpr,
      'line-width': magnitudeWidthExpr,
      'line-opacity': 0.95,
    },
  });
}
