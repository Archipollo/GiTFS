// Population analysis layer: per-cell population from JRC's GHS-POP grid
// (Global Human Settlement population, R2023A). Two sources, both already in
// EPSG:4326 (no reprojection needed) at ~100m native resolution:
//
// - 2000-2021: OpenLandMap's annual derived Cloud-Optimized GeoTIFF series,
//   one COG per year, CORS-open with working range-request support
//   (verified) — read directly, windowed, in population.worker.ts.
// - 2025: the official GHSL R2023A release's projected epoch. That source
//   has no browser-usable COG (JRC's server has no CORS headers, and the
//   data ships as 429 per-tile zips, not a single streamable file), so the
//   app's own Worker/dev-proxy re-serves the tiles same-origin (see
//   worker.ts, vite.config.ts) and population.worker.ts fetches, unzips, and
//   windows them the same way.
//
// Cells render as square grid cells (GHS-POP's native raster shape), not
// hexagons. A feed's year resolves to the nearer of these two coverage
// points, mirroring how `waybackItemIdForYear` (src/map/basemap.ts) clamps
// the historical-satellite year to its own known range.
//
// The heavy work (opening/fetching rasters, windowed reads) runs in
// population.worker.ts; this module is the main-thread client: year
// resolution, request caching, GeoJSON building, and the color scale.

import type { PopulationGridRequest, PopulationGridResponse } from './population.worker';

export const POPULATION_MIN_YEAR = 2000;
/** Last year covered by OpenLandMap's annual GHS-POP series. */
export const POPULATION_MAX_ANNUAL_YEAR = 2021;
/** JRC GHSL R2023A's projected epoch — the next real GHS-POP release after
 * the annual series ends, proxied through the app's own Worker. */
export const POPULATION_EPOCH_YEAR = 2025;

/**
 * Resolve an arbitrary feed year to an available GHS-POP year: the annual
 * series for years at or before 2021, or the nearer of 2021 and the 2025
 * epoch for anything after — so a 2023+ feed shows the real 2025 projection
 * instead of being clamped to 2021 forever.
 */
export function populationYearFor(year: number): number {
  const rounded = Math.round(year);
  if (rounded <= POPULATION_MIN_YEAR) return POPULATION_MIN_YEAR;
  if (rounded <= POPULATION_MAX_ANNUAL_YEAR) return rounded;
  const distToAnnual = rounded - POPULATION_MAX_ANNUAL_YEAR;
  const distToEpoch = Math.abs(POPULATION_EPOCH_YEAR - rounded);
  return distToEpoch <= distToAnnual ? POPULATION_EPOCH_YEAR : POPULATION_MAX_ANNUAL_YEAR;
}

/** OpenLandMap's GHS-POP annual COG asset URL (confirmed live against their STAC catalog). */
export function cogUrlForYear(year: number): string {
  return `https://s3.openlandmap.org/arco/pop.count_ghs.jrc_m_100m_s_${year}0101_${year}1231_go_epsg.4326_v20230620.tif`;
}

export type Bbox = [west: number, south: number, east: number, north: number];

export interface PopulationGrid {
  year: number;
  west: number;
  north: number;
  cellSizeX: number;
  cellSizeY: number;
  cols: number;
  rows: number;
  values: Float32Array;
}

// ---- worker plumbing (mirrors segment-graph.ts's diff-worker client) ------

let _worker: Worker | null = null;
let _msgId = 0;
const _pending = new Map<number, { resolve: (g: PopulationGrid) => void; reject: (e: Error) => void }>();

function getPopulationWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./population.worker.ts', import.meta.url), { type: 'module' });
  _worker.onmessage = (e: MessageEvent<PopulationGridResponse & { error?: string }>) => {
    const cb = _pending.get(e.data.id);
    if (!cb) return;
    _pending.delete(e.data.id);
    if (e.data.error) {
      cb.reject(new Error(e.data.error));
      return;
    }
    const { year, west, north, cellSizeX, cellSizeY, cols, rows, values } = e.data;
    cb.resolve({ year, west, north, cellSizeX, cellSizeY, cols, rows, values });
  };
  _worker.onerror = (err) => {
    const error = new Error(`population worker error: ${err.message ?? String(err)}`);
    for (const cb of _pending.values()) cb.reject(error);
    _pending.clear();
    _worker = null;
  };
  return _worker;
}

function requestPopulationGrid(year: number, bbox: Bbox): Promise<PopulationGrid> {
  const id = ++_msgId;
  return new Promise<PopulationGrid>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    const req: PopulationGridRequest = { id, year, bbox };
    getPopulationWorker().postMessage(req);
  });
}

// ---- request cache ----------------------------------------------------

// Rounds the bbox to ~3 decimal places (~100m at mid-latitudes) so panning by
// a pixel or two doesn't invalidate the cache; keyed alongside the year.
function bboxKey(bbox: Bbox): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

const gridCache = new Map<string, Promise<PopulationGrid>>();

export function getOrFetchPopulationGrid(year: number, bbox: Bbox): Promise<PopulationGrid> {
  const key = `${year}:${bboxKey(bbox)}`;
  const hit = gridCache.get(key);
  if (hit) return hit;
  const p = requestPopulationGrid(year, bbox).catch((err) => {
    gridCache.delete(key);
    throw err;
  });
  gridCache.set(key, p);
  return p;
}

// ---- absolute (single-feed) summary + GeoJSON --------------------------

export interface PopulationSummary {
  year: number;
  maxPopulation: number;
  /** 95th-percentile cell population — colour/legend scale clamps here, not
   * at the max, so one dense cell (city center) doesn't wash out every other
   * cell's colour. Mirrors `scaleWeeklyTrips` in gtfs/frequency.ts. */
  scalePopulation: number;
  cellCount: number;
}

function summarizeValues(values: readonly number[]): { max: number; scale: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  return { max, scale: p95 > 0 ? p95 : max };
}

// A 95th-percentile computed from *only whichever cells the current
// viewport happens to show* is unstable two ways at once: it flickers on
// every zoom/pan (panning out folds in low-density countryside and drags
// the percentile down; panning back in pulls it back up), and — if instead
// pinned to a monotonically-growing high-water mark — it *also* washes
// every cell out pale the moment you zoom into a small area after having
// seen a denser one, since the shrunken view no longer contains anything
// near the inflated scale. Both symptoms trace to the same mistake: tying
// the colour scale to the viewport at all.
//
// The fix is to decouple them — `bbox` below (the *view* bbox) only decides
// which cells get fetched and rendered; `scaleBbox` (the feed's full,
// viewport-independent geographic extent — see `boundsOfStops` in
// map/MapView.tsx) decides the percentile. Because `scaleBbox` never
// changes while looking at the same feed/year, the scale is deterministic
// and reused via `referenceScaleCache`, and it reflects the *whole*
// network's density distribution, so zooming into one corner of it no
// longer looks washed out relative to the rest.
const referenceScaleCache = new Map<string, Promise<{ max: number; scale: number }>>();

function referenceScaleKey(year: number, scaleBbox: Bbox): string {
  return `${year}:${scaleBbox.map((v) => v.toFixed(3)).join(',')}`;
}

function getOrComputeReferenceScale(year: number, scaleBbox: Bbox): Promise<{ max: number; scale: number }> {
  const key = referenceScaleKey(year, scaleBbox);
  const hit = referenceScaleCache.get(key);
  if (hit) return hit;
  const p = getOrFetchPopulationGrid(year, scaleBbox).then((grid) => {
    const nonZero: number[] = [];
    for (const v of grid.values) if (v > 0) nonZero.push(v);
    return summarizeValues(nonZero);
  });
  referenceScaleCache.set(key, p);
  return p;
}

export interface FeedPopulationResult {
  grid: PopulationGrid;
  summary: PopulationSummary;
}

/**
 * `bbox` is the current viewport (what gets fetched and rendered); `scaleBbox`
 * is the feed's full, fixed geographic extent, used only to compute a
 * viewport-independent colour scale (see comment on `referenceScaleCache`).
 */
export async function computeFeedPopulation(year: number, bbox: Bbox, scaleBbox: Bbox): Promise<FeedPopulationResult> {
  const resolvedYear = populationYearFor(year);
  const [grid, refScale] = await Promise.all([
    getOrFetchPopulationGrid(resolvedYear, bbox),
    getOrComputeReferenceScale(resolvedYear, scaleBbox),
  ]);
  let cellCount = 0;
  for (const v of grid.values) if (v > 0) cellCount++;
  return {
    grid,
    summary: { year: grid.year, maxPopulation: refScale.max, scalePopulation: refScale.scale, cellCount },
  };
}

/** One square-cell Polygon per populated grid cell. Empty cells (0 people,
 * the vast majority outside settlements) are skipped to keep the fill layer
 * light. */
export function feedPopulationToGeoJSON(result: FeedPopulationResult): GeoJSON.FeatureCollection {
  const { grid, summary } = result;
  const scale = summary.scalePopulation > 0 ? summary.scalePopulation : 1;
  const features: GeoJSON.Feature[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const value = grid.values[row * grid.cols + col];
      if (value <= 0) continue;
      const w = grid.west + col * grid.cellSizeX;
      const e = w + grid.cellSizeX;
      const n = grid.north - row * grid.cellSizeY;
      const s = n - grid.cellSizeY;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: { population: value, pop_norm: Math.max(0, Math.min(1, value / scale)) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---- colour scale (sequential — absolute density, low → high) ----------

/** Lowest quintile of cell population — pale. */
export const POPULATION_LOWEST_COLOR = '#fef3c7';
/** Second-lowest quintile. */
export const POPULATION_LOW_COLOR = '#fcd34d';
/** Middle quintile. */
export const POPULATION_MID_COLOR = '#f59e0b';
/** Second-highest quintile. */
export const POPULATION_HIGH_COLOR = '#c2410c';
/** Highest quintile — darkest, densest cells. */
export const POPULATION_HIGHEST_COLOR = '#7c2d12';

/** Break points on `pop_norm` ([0, 1], population scaled by `scalePopulation`). */
export const POPULATION_CLASS_BREAKS: readonly [number, number, number, number] = [0.2, 0.4, 0.6, 0.8];

export const POPULATION_FILL_OPACITY = 0.55;
