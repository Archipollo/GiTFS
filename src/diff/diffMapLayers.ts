// Shared MapLibre bootstrap for the diff-mode map views (SplitMapView,
// RouteDetailView). Both mount independent `maplibregl.Map` instances that
// only ever draw pre-computed GeoJSON (diff segments / stops / frequency) —
// they never touch DuckDB directly, so having several live instances is
// cheap relative to the worker-side diff computation itself.

import maplibregl, { type Map as MapLibreMap, type PointLike } from 'maplibre-gl';
import { SEGMENT_COLOR } from '../gtfs/segment-graph';
import { DIFF_COLOR } from './geojson';
import { basemapLayers, basemapSources } from '../map/basemap';
import { useAppStore } from '../state/app-store';

/** First layer added by `addDiffSegmentLayers` — the anchor a dynamically
 * inserted basemap (historical satellite) must slot in *below*. */
export const FIRST_DIFF_LAYER_ID = 'diff-segments-unchanged-casing';

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

/** Bounding box of every coordinate in a FeatureCollection's LineString geometries, or `null` if empty. */
export function boundsOfLineFeatures(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBoundsLike | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const feature of fc.features) {
    if (feature.geometry.type !== 'LineString') continue;
    for (const [lon, lat] of feature.geometry.coordinates) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
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
  addChevronImages(map);

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
      'line-opacity': 0.85,
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.85,
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.85,
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
    id: 'diff-segments-changed-old-casing',
    type: 'line',
    source: 'diff-segments',
    filter: ['all', ['==', ['get', 'geom_status'], 'changed'], ['==', ['get', 'changed_side'], 'old']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.0, 14, 1.6],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 4.0],
      'line-opacity': 0.85,
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
      'line-dasharray': [0, 4],
      'line-opacity': 0.95,
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
      'line-opacity': 0.85,
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
      'line-opacity': 0.95,
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
      'icon-image': ['concat', CHEVRON_IMAGE_PREFIX, ['get', 'geom_status']],
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
    'interpolate', ['linear'], ['get', 'delta_norm'],
    -1, '#ea580c', 0, '#475569', 1, '#2563eb',
  ];
  map.addLayer({
    id: 'diff-frequency-casing',
    type: 'line',
    source: 'diff-frequency',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.4, 14, 5.4],
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 14, 3.4],
      'line-opacity': 0.95,
    },
  });
}
