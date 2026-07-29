// ÖV-Güteklassen analysis layer: Austria's official ÖROK public-transport
// accessibility grading (see https://www.mobilitydata.gv.at/daten/oev-guteklassen
// and the ÖROK "Materialien Heft 10" methodology). Every location gets a
// letter grade A (best) through G (worst) from a two-stage lookup:
//
//   Stage 1 (this module, main thread — needs DuckDB): classify each stop
//   into a "Haltestellenkategorie" (I-VIII) from how frequently it's served
//   (average interval, 6:00-20:00 weekday) and which transport mode serves
//   it (rail/metro > tram > bus).
//
//   Stage 2 (gueteklassen.worker.ts, off the main thread): for every raster
//   cell, find the best Güteklasse reachable from any nearby stop, via a
//   second fixed lookup table keyed on Haltestellenkategorie x walking
//   distance band.
//
// Two documented simplifications versus the official ÖROK method (GTFS-only
// data has no way to do better):
//   - No Fernverkehr/REX distinction: GTFS route_type can't tell long-
//     distance rail apart from ordinary regional rail, so all rail/metro
//     stops map to mode category 2 and category 1 (Fernverkehr) is never
//     assigned. In practice negligible for regional Austrian feeds.
//   - Straight-line (haversine) distance to stops, not real walking-network
//     distance (ÖROK's official method uses GIP path data) — there's no
//     street/path graph available client-side.
//
// The heavy per-cell nearest-stop search runs in gueteklassen.worker.ts;
// this module is the main-thread client: stop categorization (DuckDB
// queries), worker request/cache, GeoJSON building, and the colour palette.

import { fetchStops, fetchStopPeakWindowDepartures } from './queries';
import type { Mode } from './modes';
import type { GueteklassenGridRequest, GueteklassenGridResponse } from './gueteklassen.worker';
import { useAppStore } from '../state/app-store';

export type Bbox = [west: number, south: number, east: number, north: number];

// ---- Stage 1: stop categorization ---------------------------------------

/** Index into the 8 interval-class buckets, `<5min` = 0 ... `>210min` = 7. */
export type IntervalClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** ÖROK's 4 Verkehrsmittelkategorien, ranked 1 (best) to 4 (worst). Category
 * 1 (Fernverkehr/REX) is never assigned — see the file header. */
export type ModeCategory = 1 | 2 | 3 | 4;

/** Haltestellenkategorie I (best) through VIII (worst), as 1-8. */
export type Haltestellenkategorie = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Güteklasse A (best) through G (worst), as 0-6. */
export type Guteklasse = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const GUTEKLASSE_LETTER: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function intervalClassFor(intervalMin: number): IntervalClass {
  if (intervalMin < 5) return 0;
  if (intervalMin <= 10) return 1;
  if (intervalMin < 20) return 2;
  if (intervalMin <= 40) return 3;
  if (intervalMin <= 60) return 4;
  if (intervalMin <= 120) return 5;
  if (intervalMin <= 210) return 6;
  return 7;
}

/** Simplified route_type -> mode category mapping (see file header): rail/
 * metro -> category 2, tram/trolleybus(-as-bus, already folded into 'bus'
 * by classifyRouteType) is handled via the `tram` Mode; plain bus -> 4. */
export const MODE_TO_CATEGORY: Record<Mode, ModeCategory> = {
  rail: 2,
  metro: 2,
  tram: 3,
  bus: 4,
  other: 4,
};

/**
 * Stage-1 lookup: interval class (row, 0-7) x mode category (col, 1-4) ->
 * Haltestellenkategorie (1-8), or `null` for a blank cell (service too
 * sparse at that mode to qualify for any category). Mirrors Tab. 1 of the
 * ÖROK methodology exactly.
 */
const HALTESTELLENKATEGORIE_TABLE: readonly (Haltestellenkategorie | null)[][] = [
  /* <5      */ [1, 1, 2, 3],
  /* 5-10    */ [1, 2, 3, 3],
  /* 10-20   */ [2, 3, 4, 4],
  /* 20-40   */ [3, 4, 5, 5],
  /* 40-60   */ [4, 5, 6, 6],
  /* 60-120  */ [5, 6, 7, 7],
  /* 120-210 */ [null, 7, 8, 8],
  /* >210    */ [null, null, null, null],
];

function haltestellenkategorieFor(interval: IntervalClass, category: ModeCategory): Haltestellenkategorie | null {
  return HALTESTELLENKATEGORIE_TABLE[interval][category - 1];
}

export interface CategorizedStop {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  departures: number;
  intervalMin: number;
  intervalClass: IntervalClass;
  modeCategory: ModeCategory;
  haltestellenkategorie: Haltestellenkategorie;
}

const PEAK_WINDOW_MIN = 14 * 60; // 06:00-20:00
const DIRECTION_FACTOR = 0.5;

/**
 * Classifies every stop in a feed into a Haltestellenkategorie. Stops with
 * no departures in the peak window, or whose interval/mode combination lands
 * on a blank Stage-1 table cell (very sparse rail/tram service), are dropped
 * — they simply don't contribute any Güteklasse coverage.
 */
export async function categorizeStops(feedId: string): Promise<CategorizedStop[]> {
  const [stops, departuresByStop] = await Promise.all([
    fetchStops(feedId),
    fetchStopPeakWindowDepartures(feedId),
  ]);
  const out: CategorizedStop[] = [];
  for (const stop of stops) {
    const departures = departuresByStop.get(stop.stop_id) ?? 0;
    if (departures <= 0) continue;
    const perDirection = departures * DIRECTION_FACTOR;
    if (perDirection <= 0) continue;
    const intervalMin = PEAK_WINDOW_MIN / perDirection;
    const intervalClass = intervalClassFor(intervalMin);
    const modeCategory = MODE_TO_CATEGORY[stop.primary_mode];
    const haltestellenkategorie = haltestellenkategorieFor(intervalClass, modeCategory);
    if (haltestellenkategorie == null) continue;
    out.push({
      stopId: stop.stop_id,
      stopName: stop.stop_name,
      lat: stop.lat,
      lon: stop.lon,
      departures,
      intervalMin,
      intervalClass,
      modeCategory,
      haltestellenkategorie,
    });
  }
  return out;
}

// ---- Stage 2 constants shared with the worker ---------------------------

/** Max walking-distance radius (metres) at which a stop of this
 * Haltestellenkategorie can still contribute any Güteklasse — the largest
 * non-blank column of GUTEKLASSE_TABLE for that row. Indexed 1-8. */
export const MAX_RADIUS_M_BY_KATEGORIE: Readonly<Record<Haltestellenkategorie, number>> = {
  1: 1250, 2: 1250, 3: 1250, 4: 1000, 5: 1000, 6: 750, 7: 500, 8: 300,
};

/** Upper bound (metres) of each of the 5 distance classes. */
export const DISTANCE_CLASS_BREAKS_M: readonly number[] = [300, 500, 750, 1000, 1250];

/**
 * Stage-2 lookup: Haltestellenkategorie (row, 1-8) x distance class (col,
 * 0-4) -> Güteklasse (0-6, i.e. A-G), or `null` when that combination is out
 * of range. Mirrors Tab. 3 of the ÖROK methodology exactly.
 */
export const GUTEKLASSE_TABLE: readonly (Guteklasse | null)[][] = [
  /* I    */ [0, 0, 1, 2, 3],
  /* II   */ [0, 1, 2, 3, 4],
  /* III  */ [1, 2, 3, 4, 5],
  /* IV   */ [2, 3, 4, 5, 6],
  /* V    */ [3, 4, 5, 6, 6],
  /* VI   */ [4, 5, 6, null, null],
  /* VII  */ [5, 6, 6, null, null],
  /* VIII */ [6, 6, null, null, null],
];

// ---- worker plumbing (mirrors population.ts's client) --------------------

let _worker: Worker | null = null;
let _msgId = 0;
const _pending = new Map<number, { resolve: (r: GueteklassenGridResponse) => void; reject: (e: Error) => void }>();

function getGueteklassenWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./gueteklassen.worker.ts', import.meta.url), { type: 'module' });
  _worker.onmessage = (e: MessageEvent<GueteklassenGridResponse & { error?: string }>) => {
    const cb = _pending.get(e.data.id);
    if (!cb) return;
    _pending.delete(e.data.id);
    if (e.data.error) {
      cb.reject(new Error(e.data.error));
      return;
    }
    cb.resolve(e.data);
  };
  _worker.onerror = (err) => {
    const error = new Error(`gueteklassen worker error: ${err.message ?? String(err)}`);
    for (const cb of _pending.values()) cb.reject(error);
    _pending.clear();
    _worker = null;
  };
  return _worker;
}

export interface GueteklassenGrid {
  west: number;
  north: number;
  cellSizeX: number;
  cellSizeY: number;
  cols: number;
  rows: number;
  /** Row-major, -1 = no coverage, 0-6 = A-G. */
  classes: Int8Array;
  /** Row-major, -1 = none, else 1-8 (I-VIII) — the nearest qualifying stop's category. */
  nearestKategorie: Int8Array;
  /** Row-major distance in metres to the stop that produced each cell's class. */
  nearestDistanceM: Float32Array;
}

function requestGueteklassenGrid(stops: CategorizedStop[], bbox: Bbox): Promise<GueteklassenGrid> {
  const id = ++_msgId;
  return new Promise<GueteklassenGrid>((resolve, reject) => {
    _pending.set(id, {
      resolve: (r) => resolve({
        west: r.west, north: r.north, cellSizeX: r.cellSizeX, cellSizeY: r.cellSizeY,
        cols: r.cols, rows: r.rows, classes: r.classes,
        nearestKategorie: r.nearestKategorie, nearestDistanceM: r.nearestDistanceM,
      }),
      reject,
    });
    const req: GueteklassenGridRequest = { id, stops, bbox };
    getGueteklassenWorker().postMessage(req);
  });
}

// ---- feed-level compute + cache ------------------------------------------

const stopCache = new Map<string, Promise<CategorizedStop[]>>();

function getOrCategorizeStops(feedId: string): Promise<CategorizedStop[]> {
  const hit = stopCache.get(feedId);
  if (hit) return hit;
  // Stage 1 is the slow part (DuckDB queries over every stop/trip in the
  // feed) — surface it on the shared map-busy overlay, same mechanism
  // feed-loader.ts uses for hydration, so switching into this mode doesn't
  // look broken while it runs.
  const taskId = `gueteklassen-stops-${feedId}`;
  const { beginMapTask, endMapTask } = useAppStore.getState();
  beginMapTask(taskId, 'Computing ÖV-Güteklassen stop categories…');
  const p = categorizeStops(feedId)
    .catch((err) => {
      stopCache.delete(feedId);
      throw err;
    })
    .finally(() => endMapTask(taskId));
  stopCache.set(feedId, p);
  return p;
}

export function dropFeedGueteklassenCache(feedId: string): void {
  stopCache.delete(feedId);
}

export interface GueteklassenSummary {
  classCounts: Record<Guteklasse, number>;
  noCoverageCount: number;
  cellCount: number;
  stopCount: number;
}

function emptyClassCounts(): Record<Guteklasse, number> {
  return { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
}

function summarize(grid: GueteklassenGrid, stopCount: number): GueteklassenSummary {
  const classCounts = emptyClassCounts();
  let noCoverageCount = 0;
  for (const c of grid.classes) {
    if (c < 0) noCoverageCount++;
    else classCounts[c as Guteklasse]++;
  }
  return { classCounts, noCoverageCount, cellCount: grid.classes.length, stopCount };
}

export interface FeedGueteklassenResult {
  grid: GueteklassenGrid;
  summary: GueteklassenSummary;
  stops: CategorizedStop[];
}

/**
 * `bbox` is the viewport being rendered — the whole feed's categorized stops
 * are always used (a stop just outside the viewport can still cover cells
 * inside it), only the output grid is windowed to `bbox`.
 */
export async function computeFeedGueteklassen(feedId: string, bbox: Bbox): Promise<FeedGueteklassenResult> {
  const stops = await getOrCategorizeStops(feedId);
  const grid = await requestGueteklassenGrid(stops, bbox);
  return { grid, summary: summarize(grid, stops.length), stops };
}

function bboxKey(bbox: Bbox): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

const gridCache = new Map<string, Promise<FeedGueteklassenResult>>();

export function getOrComputeFeedGueteklassen(feedId: string, bbox: Bbox): Promise<FeedGueteklassenResult> {
  const key = `${feedId}:${bboxKey(bbox)}`;
  const hit = gridCache.get(key);
  if (hit) return hit;
  const p = computeFeedGueteklassen(feedId, bbox).catch((err) => {
    gridCache.delete(key);
    throw err;
  });
  gridCache.set(key, p);
  return p;
}

// ---- GeoJSON --------------------------------------------------------------

const ROMAN: readonly string[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

/** One square-cell Polygon per covered grid cell. No-coverage cells (class
 * -1) are skipped, mirroring how population.ts skips zero-population cells. */
export function feedGueteklassenToGeoJSON(result: FeedGueteklassenResult): GeoJSON.FeatureCollection {
  const { grid } = result;
  const features: GeoJSON.Feature[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const idx = row * grid.cols + col;
      const cls = grid.classes[idx];
      if (cls < 0) continue;
      const w = grid.west + col * grid.cellSizeX;
      const e = w + grid.cellSizeX;
      const n = grid.north - row * grid.cellSizeY;
      const s = n - grid.cellSizeY;
      const kategorie = grid.nearestKategorie[idx];
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: {
          class: cls,
          class_letter: GUTEKLASSE_LETTER[cls],
          haltestellenkategorie: kategorie >= 0 ? ROMAN[kategorie - 1] : null,
          distance_m: Math.round(grid.nearestDistanceM[idx]),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---- colour scale (fixed 7-step ordinal — not data-relative) -------------
//
// A-G is an intrinsic category, not a data-relative bucket like population's
// percentile scale, so the palette is fixed rather than computed from a
// scaleBbox reference. Green (best) -> red (worst), distinct from both
// POPULATION_* (amber sequential) and the frequency diff's orange/blue ramp.

export const GUTEKLASSE_COLOR: Readonly<Record<Guteklasse, string>> = {
  0: '#1a7a3d', // A
  1: '#4fa34a', // B
  2: '#a3c957', // C
  3: '#f2e04c', // D
  4: '#f2a94c', // E
  5: '#e3703e', // F
  6: '#c0392b', // G
};

export const GUTEKLASSEN_FILL_OPACITY = 0.6;
