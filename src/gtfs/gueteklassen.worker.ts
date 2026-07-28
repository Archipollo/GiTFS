// Web Worker for the ÖV-Güteklassen analysis layer's Stage 2: for every
// raster cell in a bbox, find the best Güteklasse reachable from any nearby
// categorized stop. Unlike population.worker.ts, this worker never touches
// DuckDB (Stage 1's stop categorization runs on the main thread, see
// gueteklassen.ts) — it receives already-categorized stops and just does the
// spatial nearest-stop search off the main thread, since a feed with
// thousands of stops each touching a few hundred candidate cells is still
// enough work to visibly stutter pan/zoom if done inline.
//
// Work is bounded to O(stops x cells-in-that-stop's-radius), not
// O(stops x total-cells): each stop only searches the small pixel window its
// own Haltestellenkategorie's max radius covers (300-1250m), not the whole
// grid.

import {
  GUTEKLASSE_TABLE,
  MAX_RADIUS_M_BY_KATEGORIE,
  DISTANCE_CLASS_BREAKS_M,
  type CategorizedStop,
  type Guteklasse,
} from './gueteklassen';
import { bboxToPixelWindow, GUETEKLASSEN_PX_PER_DEG } from './gueteklassen-lattice';

export interface GueteklassenGridRequest {
  id: number;
  stops: CategorizedStop[];
  /** [west, south, east, north] in WGS84 degrees. */
  bbox: [number, number, number, number];
}

export interface GueteklassenGridResponse {
  id: number;
  west: number;
  north: number;
  cellSizeX: number;
  cellSizeY: number;
  cols: number;
  rows: number;
  classes: Int8Array;
  nearestKategorie: Int8Array;
  nearestDistanceM: Float32Array;
}

const EARTH_RADIUS_M = 6371000;

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function distanceClassFor(distM: number): number {
  for (let i = 0; i < DISTANCE_CLASS_BREAKS_M.length; i++) {
    if (distM <= DISTANCE_CLASS_BREAKS_M[i]) return i;
  }
  return -1; // beyond the last break — out of range
}

function computeGrid(req: GueteklassenGridRequest): GueteklassenGridResponse {
  const win = bboxToPixelWindow(req.bbox);
  const { west, north, cellSizeX, cellSizeY, cols, rows } = win;
  const cellCount = cols * rows;
  const classes = new Int8Array(cellCount).fill(-1);
  const nearestKategorie = new Int8Array(cellCount).fill(-1);
  const nearestDistanceM = new Float32Array(cellCount).fill(Infinity);

  if (cellCount === 0) {
    return { id: req.id, west, north, cellSizeX, cellSizeY, cols, rows, classes, nearestKategorie, nearestDistanceM };
  }

  for (const stop of req.stops) {
    const kategorie = stop.haltestellenkategorie;
    const row = GUTEKLASSE_TABLE[kategorie - 1];
    const maxRadiusM = MAX_RADIUS_M_BY_KATEGORIE[kategorie];
    // Degrees-per-metre at this stop's latitude, converted to a local pixel
    // radius so only cells that could possibly be in range are visited.
    const latRadiusDeg = maxRadiusM / 111320;
    const lonRadiusDeg = maxRadiusM / (111320 * Math.max(0.1, Math.cos((stop.lat * Math.PI) / 180)));
    const radiusColPx = Math.ceil(lonRadiusDeg * GUETEKLASSEN_PX_PER_DEG);
    const radiusRowPx = Math.ceil(latRadiusDeg * GUETEKLASSEN_PX_PER_DEG);

    const stopColLocal = Math.round((stop.lon - west) / cellSizeX);
    const stopRowLocal = Math.round((north - stop.lat) / cellSizeY);

    const colFrom = Math.max(0, stopColLocal - radiusColPx);
    const colTo = Math.min(cols - 1, stopColLocal + radiusColPx);
    const rowFrom = Math.max(0, stopRowLocal - radiusRowPx);
    const rowTo = Math.min(rows - 1, stopRowLocal + radiusRowPx);

    for (let r = rowFrom; r <= rowTo; r++) {
      const cellLat = north - (r + 0.5) * cellSizeY;
      for (let c = colFrom; c <= colTo; c++) {
        const cellLon = west + (c + 0.5) * cellSizeX;
        const distM = haversineM(stop.lat, stop.lon, cellLat, cellLon);
        if (distM > maxRadiusM) continue;
        const distClass = distanceClassFor(distM);
        if (distClass < 0) continue;
        const cls = row[distClass];
        if (cls == null) continue;
        const idx = r * cols + c;
        if (classes[idx] === -1 || (cls as Guteklasse) < classes[idx]) {
          classes[idx] = cls;
          nearestKategorie[idx] = kategorie;
          nearestDistanceM[idx] = distM;
        }
      }
    }
  }

  // Cells that never got touched keep distance Infinity — normalize to 0 for
  // a clean typed-array payload (class/kategorie already read -1 there).
  for (let i = 0; i < nearestDistanceM.length; i++) {
    if (!Number.isFinite(nearestDistanceM[i])) nearestDistanceM[i] = 0;
  }

  return { id: req.id, west, north, cellSizeX, cellSizeY, cols, rows, classes, nearestKategorie, nearestDistanceM };
}

self.onmessage = (e: MessageEvent<GueteklassenGridRequest>) => {
  try {
    const res = computeGrid(e.data);
    (self as unknown as Worker).postMessage(res, [
      res.classes.buffer,
      res.nearestKategorie.buffer,
      res.nearestDistanceM.buffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, error: String((err as Error)?.message ?? err) });
  }
};
