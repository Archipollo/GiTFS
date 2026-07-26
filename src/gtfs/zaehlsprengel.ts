// Population analysis layer, alternate data source: Statistik Austria's
// "Zählsprengel" (census enumeration districts) — real registry population
// counts on real administrative boundaries, an Austria-specific alternative
// to GHS-POP's global 100m raster (gtfs/population.ts). Selected via
// `populationSource` in the store; GHS-POP stays the default since it's the
// only source with a year-over-year time series (Zählsprengel is a single
// current snapshot, not comparable across feed years — see below).
//
// Two pieces, both free/open, joined client-side by Zählsprengel ID:
//
// - Boundaries + IDs: fetched live per-bbox from Statistik Austria's own
//   WFS (`www.statistik.at/gs-open/GEODATA/ows`), which serves GeoJSON
//   already reprojected to EPSG:4326 (source data is EPSG:31287/MGI
//   Lambert; the WFS does the reprojection server-side, so no proj4
//   dependency is needed client-side) and supports server-side BBOX
//   filtering — confirmed CORS-open (`Access-Control-Allow-Origin: *`),
//   mirroring the bbox-windowed fetch pattern population.worker.ts uses for
//   the GHS-POP raster.
// - Population counts: Statistik Austria's INSPIRE "Wohnbevölkerung nach
//   Zählsprengel" registry dataset ships as a single ~160MB GML (one
//   `<pd:value>` block per Zählsprengel per demographic breakdown —
//   population-by-age/sex, not just totals) with no CORS headers, so it
//   isn't fetchable from the browser at all, let alone practical to parse
//   client-side. Pre-extracted once (id -> total population only, dropping
//   every age/sex breakdown) into `public/data/zsp-population-2026.json`
//   (~135KB for all 8,811 Zählsprengel, summing to Austria's real
//   ~9.22M population) and bundled as a static asset. Re-extract by
//   downloading a fresh GML from the same INSPIRE endpoint (dataset id
//   7767c34f-302c-11e3-beb4-0000c1ab0db6) and taking, per Zählsprengel ID,
//   the one `<pd:StatisticalValue>` whose `<pd:dimensions>` has no
//   `<pd:thematic>` child (that's the total; every age/sex-broken-down
//   entry has one).
//
// Unlike GHS-POP, there's no historical Zählsprengel series bundled here —
// this is always the current registry snapshot, independent of feed year.
// So there's no diff mode for this source: every view (single-feed, split,
// network-diff) just shows the same current absolute density choropleth,
// same as GHS-POP's single-feed ("absolute") rendering.

import type { Bbox } from './population';

const WFS_URL = 'https://www.statistik.at/gs-open/GEODATA/ows';
const WFS_TYPE_NAME = 'GEODATA:STATISTIK_AUSTRIA_ZSP_20260101';
/** Registry snapshot date backing both the WFS boundaries above and the
 * bundled population lookup — not a feed year, just a fixed reference. */
export const ZAEHLSPRENGEL_REFERENCE_YEAR = 2026;

const POPULATION_LOOKUP_URL = '/data/zsp-population-2026.json';

interface ZaehlsprengelProperties {
  g_id: string;
  g_name: string;
}

type ZaehlsprengelBoundary = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, ZaehlsprengelProperties>;

function buildWfsUrl(bbox: Bbox): string {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: WFS_TYPE_NAME,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    bbox: `${west},${south},${east},${north},EPSG:4326`,
  });
  return `${WFS_URL}?${params.toString()}`;
}

async function fetchZaehlsprengelBoundaries(bbox: Bbox): Promise<ZaehlsprengelBoundary[]> {
  const res = await fetch(buildWfsUrl(bbox));
  if (!res.ok) throw new Error(`Zählsprengel WFS request failed: ${res.status}`);
  const collection = (await res.json()) as GeoJSON.FeatureCollection<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    ZaehlsprengelProperties
  >;
  return collection.features;
}

let _lookupPromise: Promise<Record<string, number>> | null = null;

function getPopulationLookup(): Promise<Record<string, number>> {
  if (!_lookupPromise) {
    _lookupPromise = fetch(POPULATION_LOOKUP_URL).then((res) => {
      if (!res.ok) throw new Error(`Zählsprengel population lookup failed: ${res.status}`);
      return res.json() as Promise<Record<string, number>>;
    });
  }
  return _lookupPromise;
}

export interface ZaehlsprengelSummary {
  year: number;
  maxPopulation: number;
  /** 95th-percentile unit population — colour/legend scale clamps here, same
   * rationale as `PopulationSummary.scalePopulation` in gtfs/population.ts. */
  scalePopulation: number;
  unitCount: number;
}

export interface ZaehlsprengelResult {
  geojson: GeoJSON.FeatureCollection;
  summary: ZaehlsprengelSummary;
}

function summarizeValues(values: readonly number[]): { max: number; scale: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  return { max, scale: p95 > 0 ? p95 : max };
}

// See the matching comment in gtfs/population.ts: recomputing the 95th
// percentile from only the units currently in view is unstable two ways at
// once — it flickers on every zoom/pan, and it washes units out pale when
// zooming into a small area after a denser one inflated the scale. Fixed the
// same way: `scaleBbox` (the feed's full, viewport-independent geographic
// extent) decides the percentile, fetched and cached deterministically per
// area; `bbox` (the viewport) only decides which units get fetched and
// rendered.
function bboxKey(bbox: Bbox): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

const referenceScaleCache = new Map<string, Promise<{ max: number; scale: number }>>();

function getOrComputeReferenceScale(scaleBbox: Bbox): Promise<{ max: number; scale: number }> {
  const key = bboxKey(scaleBbox);
  const hit = referenceScaleCache.get(key);
  if (hit) return hit;
  const p = Promise.all([getPopulationLookup(), fetchZaehlsprengelBoundaries(scaleBbox)]).then(
    ([lookup, boundaries]) => {
      const values: number[] = [];
      for (const feature of boundaries) {
        const population = lookup[feature.properties.g_id];
        if (population != null && population > 0) values.push(population);
      }
      return summarizeValues(values);
    },
  );
  referenceScaleCache.set(key, p);
  return p;
}

/**
 * `bbox` is the current viewport (what gets fetched and rendered); `scaleBbox`
 * is the feed's full, fixed geographic extent, used only to compute a
 * viewport-independent colour scale (see comment above).
 */
async function computeZaehlsprengelPopulation(bbox: Bbox, scaleBbox: Bbox): Promise<ZaehlsprengelResult> {
  const [lookup, boundaries, refScale] = await Promise.all([
    getPopulationLookup(),
    fetchZaehlsprengelBoundaries(bbox),
    getOrComputeReferenceScale(scaleBbox),
  ]);

  const populated: { geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon; population: number }[] = [];
  for (const feature of boundaries) {
    const population = lookup[feature.properties.g_id];
    if (population == null || population <= 0) continue;
    populated.push({ geometry: feature.geometry, population });
  }

  const denom = refScale.scale > 0 ? refScale.scale : 1;
  const features: GeoJSON.Feature[] = populated.map(({ geometry, population }) => ({
    type: 'Feature',
    geometry,
    properties: { population, pop_norm: Math.max(0, Math.min(1, population / denom)) },
  }));

  return {
    geojson: { type: 'FeatureCollection', features },
    summary: {
      year: ZAEHLSPRENGEL_REFERENCE_YEAR,
      maxPopulation: refScale.max,
      scalePopulation: refScale.scale,
      unitCount: features.length,
    },
  };
}

// ---- request cache (mirrors gtfs/population.ts's gridCache) ------------

const resultCache = new Map<string, Promise<ZaehlsprengelResult>>();

export function getOrComputeZaehlsprengelPopulation(bbox: Bbox, scaleBbox: Bbox): Promise<ZaehlsprengelResult> {
  const key = `${bboxKey(bbox)}:${bboxKey(scaleBbox)}`;
  const hit = resultCache.get(key);
  if (hit) return hit;
  const p = computeZaehlsprengelPopulation(bbox, scaleBbox).catch((err) => {
    resultCache.delete(key);
    throw err;
  });
  resultCache.set(key, p);
  return p;
}
