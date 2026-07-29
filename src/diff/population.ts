// Diff-mode *population* overlay: per-cell population change between feed
// A's and feed B's nearest GHS-POP year (see ../gtfs/population.ts for the
// dataset — annual 2000-2021, or the JRC GHSL 2025 epoch beyond that).
// Unlike the frequency diff (per-route line), this is a per-cell fill — a
// square grid cell's delta is `populationB - populationA` for the same
// cell, which is meaningful because every year snaps to the same pixel
// lattice for a given bbox (population.worker.ts's GRID_ORIGIN_*/
// GRID_PX_PER_DEG constants, shared by both the annual and epoch fetch
// paths), so cells line up index-for-index without any re-gridding step.

import {
  populationYearFor,
  getOrFetchPopulationGrid,
  cellAreaHectares,
  rowCenterLat,
  type Bbox,
  type PopulationGrid,
} from '../gtfs/population';

const METERS_PER_DEG_LAT = 111_320;
import type { DiffedShapes } from '../gtfs/segment-graph';

export interface PopulationDiffResult {
  feedA: string;
  feedB: string;
  yearA: number;
  yearB: number;
  /** Shared grid geometry (both years' grids share the same window/decimation
   * for a given bbox, so either one's geometry describes both). */
  grid: PopulationGrid;
  /**
   * `'delta'` when feed A and feed B resolve to different GHS-POP years — the
   * usual gained/lost-population overlay. `'absolute'` when they resolve to
   * the *same* year: a delta would be all zeros (nothing to show), so this
   * carries feed B's absolute per-cell population instead, rendered as a
   * plain density choropleth (more people → darker), same as the single-feed
   * view.
   */
  mode: 'delta' | 'absolute';
  /** Row-major `populationB - populationA`, same indexing as `grid.values`.
   * Only meaningful when `mode === 'delta'`. */
  deltas: Float32Array;
  /** Row-major per-cell population for feed A/B, same indexing as `deltas` —
   * carried alongside the delta so the hover tooltip can show "X → Y" instead
   * of just the bare change. Only populated when `mode === 'delta'`. */
  populationA: Float32Array;
  populationB: Float32Array;
  /** People/hectare, not raw people — see `cellAreaHectares`. */
  maxAbsDelta: number;
  /** |delta density| at which colour maxes out — the 95th-percentile
   * |delta| (people/hectare), not the maximum, mirroring `scaleAbsDelta` in
   * diff/frequency.ts. */
  scaleAbsDelta: number;
  /** Row-major absolute population, same indexing as `grid.values`. Only
   * populated when `mode === 'absolute'`. */
  population: Float32Array;
  /** People/hectare, not raw people — see `cellAreaHectares`. Populated in
   * both modes: `'absolute'` mode's own density, or (in `'delta'` mode)
   * feed B's density, for the "show density instead of change" toggle. */
  maxPopulation: number;
  /** Density at which colour maxes out — the 95th-percentile cell density
   * (people/hectare), mirroring `scalePopulation` in gtfs/population.ts.
   * Populated in both modes — see `maxPopulation`. */
  scalePopulation: number;
  cellCount: number;
  /** Cell size in meters (north-south edge) at the tile-pyramid level the
   * underlying grid resolved to — for the legend caption. */
  cellSizeMeters: number;
}

function summarizeAbsDeltas(deltas: readonly number[]): { maxAbsDelta: number; scaleAbsDelta: number } {
  const sorted = deltas.map((d) => Math.abs(d)).sort((a, b) => a - b);
  const maxAbsDelta = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  return { maxAbsDelta, scaleAbsDelta: p95 > 0 ? p95 : maxAbsDelta };
}

/** Mirrors `summarizeValues` in gtfs/population.ts — kept local since it's a
 * different (non-abs-delta) shape than `summarizeAbsDeltas` above. */
function summarizeValues(values: readonly number[]): { max: number; scale: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  return { max, scale: p95 > 0 ? p95 : max };
}

// See the matching comment in gtfs/population.ts: a percentile scale
// recomputed from only the currently-visible cells is unstable two ways at
// once — it flickers on every zoom/pan, and it washes cells out pale on
// zooming into a smaller area after a denser one inflated the scale. Fixed
// the same way: `scaleBbox` (the feed pair's full, viewport-independent
// geographic extent — see `boundsOfDiffedShapes` below) decides the
// percentile, cached and reused deterministically; `bbox` (the viewport)
// only decides which cells get fetched and rendered.
const referenceScaleCacheAbsolute = new Map<string, Promise<{ max: number; scale: number }>>();
const referenceScaleCacheDelta = new Map<string, Promise<{ maxAbsDelta: number; scaleAbsDelta: number }>>();

function scaleBboxKey(scaleBbox: Bbox): string {
  return scaleBbox.map((v) => v.toFixed(3)).join(',');
}

function getOrComputeAbsoluteReferenceScale(year: number, scaleBbox: Bbox): Promise<{ max: number; scale: number }> {
  const key = `${year}:${scaleBboxKey(scaleBbox)}`;
  const hit = referenceScaleCacheAbsolute.get(key);
  if (hit) return hit;
  const p = getOrFetchPopulationGrid(year, scaleBbox).then((grid) => {
    const nonZero: number[] = [];
    for (let row = 0; row < grid.rows; row++) {
      const area = cellAreaHectares(grid.cellSizeX, grid.cellSizeY, rowCenterLat(grid, row));
      for (let col = 0; col < grid.cols; col++) {
        const v = grid.values[row * grid.cols + col];
        if (v > 0) nonZero.push(v / area);
      }
    }
    return summarizeValues(nonZero);
  });
  referenceScaleCacheAbsolute.set(key, p);
  return p;
}

function getOrComputeDeltaReferenceScale(
  yearA: number,
  yearB: number,
  scaleBbox: Bbox,
): Promise<{ maxAbsDelta: number; scaleAbsDelta: number }> {
  const key = `${yearA}:${yearB}:${scaleBboxKey(scaleBbox)}`;
  const hit = referenceScaleCacheDelta.get(key);
  if (hit) return hit;
  const p = Promise.all([
    getOrFetchPopulationGrid(yearA, scaleBbox),
    getOrFetchPopulationGrid(yearB, scaleBbox),
  ]).then(([gridA, gridB]) => {
    const cols = Math.min(gridA.cols, gridB.cols);
    const rows = Math.min(gridA.rows, gridB.rows);
    const deltas: number[] = [];
    for (let row = 0; row < rows; row++) {
      const area = cellAreaHectares(gridB.cellSizeX, gridB.cellSizeY, rowCenterLat(gridB, row));
      for (let col = 0; col < cols; col++) {
        const d = gridB.values[row * gridB.cols + col] - gridA.values[row * gridA.cols + col];
        if (d !== 0) deltas.push(d / area);
      }
    }
    return summarizeAbsDeltas(deltas);
  });
  referenceScaleCacheDelta.set(key, p);
  return p;
}

/**
 * `bbox` is the current viewport (what gets fetched and rendered); `scaleBbox`
 * is the feed pair's full, fixed geographic extent (see
 * `boundsOfDiffedShapes`), used only to compute a viewport-independent colour
 * scale (see comment on the reference-scale caches above).
 */
export async function computePopulationDiff(
  feedA: string,
  feedB: string,
  yearRawA: number,
  yearRawB: number,
  bbox: Bbox,
  scaleBbox: Bbox,
): Promise<PopulationDiffResult> {
  const yearA = populationYearFor(yearRawA);
  const yearB = populationYearFor(yearRawB);

  // Same GHS-POP year on both sides (either the feed years genuinely match,
  // or both clamp to the same edge of the dataset's 2000-2021 range) — a
  // per-cell delta would be all zeros, so show feed B's absolute density
  // instead rather than an overlay with nothing to show.
  if (yearA === yearB) {
    const gridB = await getOrFetchPopulationGrid(yearB, bbox);
    const population = new Float32Array(gridB.values.length);
    let cellCount = 0;
    for (let i = 0; i < gridB.values.length; i++) {
      const v = gridB.values[i];
      population[i] = v;
      if (v > 0) cellCount++;
    }
    const { max: maxPopulation, scale: scalePopulation } = await getOrComputeAbsoluteReferenceScale(yearB, scaleBbox);
    return {
      feedA,
      feedB,
      yearA,
      yearB,
      grid: gridB,
      mode: 'absolute',
      deltas: new Float32Array(0),
      populationA: new Float32Array(0),
      populationB: new Float32Array(0),
      maxAbsDelta: 0,
      scaleAbsDelta: 0,
      population,
      maxPopulation,
      scalePopulation,
      cellCount,
      cellSizeMeters: Math.round(gridB.cellSizeY * METERS_PER_DEG_LAT),
    };
  }

  const [gridA, gridB] = await Promise.all([
    getOrFetchPopulationGrid(yearA, bbox),
    getOrFetchPopulationGrid(yearB, bbox),
  ]);
  // Also fetch feed B's absolute density scale — not used for the delta
  // ramp, but needed so a "show density instead of change" toggle (see
  // `PopulationClassMode`) has a reference scale to classify against.
  const { max: maxPopulation, scale: scalePopulation } = await getOrComputeAbsoluteReferenceScale(yearB, scaleBbox);

  // Both requests share the same bbox and decimation cap, so they resolve to
  // the same window/grid shape — but guard against a mismatch (e.g. one grid
  // clipped differently at an image edge) by only diffing the overlapping
  // cells, rather than assuming identical dimensions.
  const cols = Math.min(gridA.cols, gridB.cols);
  const rows = Math.min(gridA.rows, gridB.rows);
  const deltas = new Float32Array(rows * cols);
  const populationA = new Float32Array(rows * cols);
  const populationB = new Float32Array(rows * cols);
  let cellCount = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = gridA.values[row * gridA.cols + col];
      const b = gridB.values[row * gridB.cols + col];
      const d = b - a;
      const idx = row * cols + col;
      deltas[idx] = d;
      populationA[idx] = a;
      populationB[idx] = b;
      if (d !== 0) cellCount++;
    }
  }
  const { maxAbsDelta, scaleAbsDelta } = await getOrComputeDeltaReferenceScale(yearA, yearB, scaleBbox);

  return {
    feedA,
    feedB,
    yearA,
    yearB,
    grid: { ...gridA, cols, rows },
    mode: 'delta',
    deltas,
    populationA,
    populationB,
    maxAbsDelta,
    scaleAbsDelta,
    population: new Float32Array(0),
    maxPopulation,
    scalePopulation,
    cellCount,
    cellSizeMeters: Math.round(gridA.cellSizeY * METERS_PER_DEG_LAT),
  };
}

// ---- cache (per feedA,feedB,yearA,yearB,bbox,scaleBbox) ----------------

function bboxKey(bbox: Bbox): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

const cache = new Map<string, Promise<PopulationDiffResult>>();

export function getOrComputePopulationDiff(
  feedA: string,
  feedB: string,
  yearRawA: number,
  yearRawB: number,
  bbox: Bbox,
  scaleBbox: Bbox,
): Promise<PopulationDiffResult> {
  const key = `${feedA}:${feedB}:${yearRawA}:${yearRawB}:${bboxKey(bbox)}:${bboxKey(scaleBbox)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = computePopulationDiff(feedA, feedB, yearRawA, yearRawB, bbox, scaleBbox).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}

/**
 * Bbox over every run's coordinates in a diffed feed pair — feed A's and
 * feed B's combined geographic footprint, independent of the current map
 * viewport or any visibility-toggle filtering. Used as the population
 * overlay's `scaleBbox` (see `computePopulationDiff`) so the colour scale
 * reflects the whole network being compared, not just whatever's on screen.
 */
export function boundsOfDiffedShapes(diffedShapes: DiffedShapes): Bbox | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const run of diffedShapes.runs) {
    for (const [lon, lat] of run.coords) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return west === Infinity ? null : [west, south, east, north];
}

// ---- colour scale (diverging — loss / gain) ----------------------------

// Distinct palette from the frequency diff's orange/gray/blue (service
// gained/lost) so the two "gained/lost" overlays never read as the same
// feature — population uses a red (loss) / neutral / green (gain) ramp,
// the more conventional demographic-change convention.
/** Large population loss — dark red. */
export const POPULATION_BIG_LOSS_COLOR = '#991b1b';
/** Small population loss — light red. */
export const POPULATION_SMALL_LOSS_COLOR = '#f87171';
/** ~No change — light neutral gray. */
export const POPULATION_NEUTRAL_COLOR = '#e5e7eb';
/** Small population gain — light green. */
export const POPULATION_SMALL_GAIN_COLOR = '#4ade80';
/** Large population gain — dark green. */
export const POPULATION_BIG_GAIN_COLOR = '#166534';

/**
 * Break points on `pop_delta_density` (people/hectare, not a
 * percentile-scaled ratio) — fixed thresholds rather than
 * `scaleAbsDelta`-relative ones, so a ±5 wobble in a handful of cells
 * doesn't count as a "big" change just because the network-wide p95 happens
 * to be small; only genuinely notable shifts (double digits) fall outside
 * the neutral band. Density, not raw per-cell people, so the same numbers
 * mean the same thing whether the grid is currently rendering ~100m native
 * cells or coarser tile-pyramid cells (see `cellAreaHectares`) — a native
 * GHS-POP cell is close to 1 hectare, so these values read about the same
 * as the old raw-people breaks at native zoom.
 */
export const POPULATION_DIFF_CLASS_BREAKS: readonly [number, number, number, number] = [-25, -10, 10, 25];

export const POPULATION_DIFF_FILL_OPACITY = 0.6;

/**
 * `'change'` (default) colours cells by loss/gain (`pop_delta_density`) —
 * today's behaviour. `'density'` colours by feed B's absolute density
 * (`pop_norm`) instead, so a viewer can see where the network area is
 * generally dense or sparse without leaving diff mode. Mirrors
 * `FrequencyClassMode` in `frequency.ts`.
 */
export type PopulationClassMode = 'change' | 'density';

// ---- GeoJSON ------------------------------------------------------------

/**
 * One square-cell Polygon per grid cell. In `'delta'` mode, zero-delta cells
 * are skipped and each feature carries `pop_delta` (raw people, for the
 * tooltip) and `pop_delta_density` (people/hectare — what the fixed
 * absolute breaks in `POPULATION_DIFF_CLASS_BREAKS` actually classify,
 * since raw per-cell people isn't comparable across the tile-pyramid's
 * varying cell sizes; see `cellAreaHectares`). In `'absolute'` mode (feed A
 * and B share a GHS-POP year), empty cells are skipped instead and each
 * feature carries `population`/`pop_norm` (sequential scale, `pop_norm`
 * likewise density-based) — the same shape `feedPopulationToGeoJSON` in
 * gtfs/population.ts produces for the single-feed view.
 */
export function populationDiffToGeoJSON(result: PopulationDiffResult): GeoJSON.FeatureCollection {
  const { grid } = result;
  const features: GeoJSON.Feature[] = [];

  const cellPolygon = (row: number, col: number): GeoJSON.Polygon => {
    const w = grid.west + col * grid.cellSizeX;
    const e = w + grid.cellSizeX;
    const n = grid.north - row * grid.cellSizeY;
    const s = n - grid.cellSizeY;
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  };

  if (result.mode === 'absolute') {
    const scale = result.scalePopulation > 0 ? result.scalePopulation : 1;
    for (let row = 0; row < grid.rows; row++) {
      const area = cellAreaHectares(grid.cellSizeX, grid.cellSizeY, rowCenterLat(grid, row));
      for (let col = 0; col < grid.cols; col++) {
        const value = result.population[row * grid.cols + col];
        if (value <= 0) continue;
        const density = value / area;
        features.push({
          type: 'Feature',
          geometry: cellPolygon(row, col),
          properties: { population: value, pop_norm: Math.max(0, Math.min(1, density / scale)) },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const densityScale = result.scalePopulation > 0 ? result.scalePopulation : 1;
  for (let row = 0; row < grid.rows; row++) {
    const area = cellAreaHectares(grid.cellSizeX, grid.cellSizeY, rowCenterLat(grid, row));
    for (let col = 0; col < grid.cols; col++) {
      const idx = row * grid.cols + col;
      const delta = result.deltas[idx];
      const a = result.populationA[idx];
      const b = result.populationB[idx];
      // Keep populated-but-unchanged cells too (not just delta !== 0) — the
      // density toggle needs full coverage of feed B's populated area, not
      // just the cells that happened to change.
      if (delta === 0 && b <= 0) continue;
      const densityB = b / area;
      features.push({
        type: 'Feature',
        geometry: cellPolygon(row, col),
        properties: {
          pop_delta: delta,
          pop_delta_density: delta / area,
          population_a: a,
          population_b: b,
          pop_density_a: a / area,
          pop_density_b: densityB,
          pop_norm: Math.max(0, Math.min(1, densityB / densityScale)),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
