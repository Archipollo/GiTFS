// Shared basemap plumbing for every MapLibre instance in the app: the four
// selectable raster styles (`mapStyle`) and the Esri Wayback historical
// satellite overlay (`historicalBasemap`). MapView, NetworkDiffMapView and
// SplitMapView all build their style from here so a style added once shows
// up in all of them.

import { useEffect, useRef } from 'react';
import type maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useAppStore, type MapStyle } from '../state/app-store';

const CARTO_ATTR = '© OpenStreetMap contributors, © CARTO';
const CARTO_TILES = (style: string) => [
  `https://a.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://b.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://c.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
  `https://d.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`,
];

/** Layer/source id for each selectable style. */
const BASEMAP_LAYER_ID: Record<MapStyle, string> = {
  standard: 'basemap_standard',
  voyager: 'basemap_voyager',
  dark: 'basemap_dark',
  positron: 'basemap_positron',
};

const HISTORICAL_LAYER_ID = 'basemap_historical';

/**
 * Fresh source/layer specs per call — MapLibre mutates the style spec it is
 * given while loading, so two map instances must never share one object
 * (SplitMapView mounts two concurrently).
 */
export function basemapSources(): Record<string, maplibregl.SourceSpecification> {
  return {
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
    basemap_positron: {
      type: 'raster',
      tiles: CARTO_TILES('light_all'),
      tileSize: 256,
      attribution: CARTO_ATTR,
      maxzoom: 19,
    },
  };
}

/** Matching layer list — `visible` picks which one starts shown. */
export function basemapLayers(visible: MapStyle): maplibregl.LayerSpecification[] {
  return (Object.keys(BASEMAP_LAYER_ID) as MapStyle[]).map((style) => ({
    id: BASEMAP_LAYER_ID[style],
    type: 'raster' as const,
    source: BASEMAP_LAYER_ID[style],
    ...(style === visible ? {} : { layout: { visibility: 'none' as const } }),
  }));
}

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

export function waybackItemIdForYear(year: number): number {
  if (year in WAYBACK_BY_YEAR) return WAYBACK_BY_YEAR[year];
  // Clamp to the nearest known year
  const years = Object.keys(WAYBACK_BY_YEAR).map(Number).sort((a, b) => a - b);
  if (year <= years[0]) return WAYBACK_BY_YEAR[years[0]];
  if (year >= years[years.length - 1]) return WAYBACK_BY_YEAR[years[years.length - 1]];
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

/**
 * Drive one map's basemap: show the selected `mapStyle` raster, or swap in the
 * Wayback snapshot for `year` when historical mode is on.
 *
 * `year` is null when no era is resolvable (no feed loaded) — the regular
 * basemap then stays visible even with historical mode enabled, since there is
 * no replacement layer to show.
 *
 * `beforeId` anchors the satellite layer *under* the map's own content layers;
 * without it the imagery paints over the routes.
 */
export function useBasemap(
  mapRef: { current: MapLibreMap | null },
  ready: boolean,
  year: number | null,
  beforeId: string,
): void {
  const mapStyle = useAppStore((s) => s.mapStyle);
  const historicalBasemap = useAppStore((s) => s.historicalBasemap);
  // Which Wayback itemId is currently mounted, so year scrubs only re-add on
  // an actual snapshot change.
  const itemIdRef = useRef<number | null>(null);

  const showingWayback = historicalBasemap && year != null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const style of Object.keys(BASEMAP_LAYER_ID) as MapStyle[]) {
      const id = BASEMAP_LAYER_ID[style];
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(
        id,
        'visibility',
        !showingWayback && mapStyle === style ? 'visible' : 'none',
      );
    }
  }, [mapRef, mapStyle, showingWayback, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const removeWayback = () => {
      if (itemIdRef.current === null) return;
      if (map.getLayer(HISTORICAL_LAYER_ID)) map.removeLayer(HISTORICAL_LAYER_ID);
      if (map.getSource(HISTORICAL_LAYER_ID)) map.removeSource(HISTORICAL_LAYER_ID);
      itemIdRef.current = null;
    };

    if (!showingWayback || year == null) {
      removeWayback();
      return;
    }

    const itemId = waybackItemIdForYear(year);
    if (itemIdRef.current === itemId) return;

    removeWayback();
    map.addSource(HISTORICAL_LAYER_ID, {
      type: 'raster',
      tiles: WAYBACK_TILES(itemId),
      tileSize: 256,
      attribution: waybackAttr(itemId),
      maxzoom: 17,
    });
    map.addLayer(
      { id: HISTORICAL_LAYER_ID, type: 'raster', source: HISTORICAL_LAYER_ID },
      map.getLayer(beforeId) ? beforeId : undefined,
    );
    itemIdRef.current = itemId;
  }, [mapRef, showingWayback, year, beforeId, ready]);
}
