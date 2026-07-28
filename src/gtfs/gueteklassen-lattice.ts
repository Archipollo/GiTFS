// Canonical raster lattice for the ÖV-Güteklassen analysis layer — its own
// grid, independent of the population module's GHS-POP lattice (different
// dataset, no reason to couple their pixel grids together). Both the main
// thread (gueteklassen.ts) and the worker (gueteklassen.worker.ts) derive
// their pixel windows from these same constants so a repeated request for
// the same bbox always produces an identical grid — which the diff view
// depends on for index-aligned per-cell comparison between two feeds.

/** Arbitrary but fixed origin — an integer degree north-west of Austria, so
 * every cell boundary lands on a clean, reproducible line regardless of
 * which bbox a request happens to start from. */
export const GUETEKLASSEN_GRID_ORIGIN_LON = -20;
export const GUETEKLASSEN_GRID_ORIGIN_LAT = 60;

/** ~100m cells at Austria's latitude, matching the population layer's
 * resolution for visual consistency between the two overlays. */
export const GUETEKLASSEN_PX_PER_DEG = 1 / 0.0008333333300327;

/** Hard cap on the output grid's larger dimension — bounds render/transfer
 * cost the same way population.worker.ts's MAX_GRID_DIM does. 180 is enough
 * resolution to resolve the finest (300m) distance-class boundary while
 * keeping a country-scale bbox request cheap. */
export const GUETEKLASSEN_MAX_GRID_DIM = 180;

export interface PixelWindow {
  west: number;
  north: number;
  cellSizeX: number;
  cellSizeY: number;
  cols: number;
  rows: number;
  /** Pixel-lattice column/row of the window's left/top edge — the offset
   * cell-index math (e.g. converting a stop's lat/lon into a local window)
   * needs to place things relative to. */
  leftPx: number;
  topPx: number;
}

/**
 * Snaps a requested bbox onto the shared pixel lattice and caps it at
 * `GUETEKLASSEN_MAX_GRID_DIM`, mirroring population.worker.ts's window-
 * snapping logic (see its GRID_ORIGIN / GRID_PX_PER_DEG constants).
 */
export function bboxToPixelWindow(bbox: readonly [number, number, number, number]): PixelWindow {
  const [west, south, east, north] = bbox;
  const leftPx = Math.round((west - GUETEKLASSEN_GRID_ORIGIN_LON) * GUETEKLASSEN_PX_PER_DEG);
  const rightPx = Math.round((east - GUETEKLASSEN_GRID_ORIGIN_LON) * GUETEKLASSEN_PX_PER_DEG);
  const topPx = Math.round((GUETEKLASSEN_GRID_ORIGIN_LAT - north) * GUETEKLASSEN_PX_PER_DEG);
  const bottomPx = Math.round((GUETEKLASSEN_GRID_ORIGIN_LAT - south) * GUETEKLASSEN_PX_PER_DEG);

  const nativeCols = Math.max(0, rightPx - leftPx);
  const nativeRows = Math.max(0, bottomPx - topPx);
  const cols = Math.min(nativeCols, GUETEKLASSEN_MAX_GRID_DIM);
  const rows = Math.min(nativeRows, GUETEKLASSEN_MAX_GRID_DIM);

  const snappedWest = GUETEKLASSEN_GRID_ORIGIN_LON + leftPx / GUETEKLASSEN_PX_PER_DEG;
  const snappedNorth = GUETEKLASSEN_GRID_ORIGIN_LAT - topPx / GUETEKLASSEN_PX_PER_DEG;
  // Cell size grows past native 1-pixel-per-cell only if the bbox was capped
  // above MAX_GRID_DIM (an extreme zoomed-out view) — same coarsening
  // tradeoff population.worker.ts makes.
  const cellSizeX = cols > 0 ? (rightPx - leftPx) / GUETEKLASSEN_PX_PER_DEG / cols : 0;
  const cellSizeY = rows > 0 ? (bottomPx - topPx) / GUETEKLASSEN_PX_PER_DEG / rows : 0;

  return { west: snappedWest, north: snappedNorth, cellSizeX, cellSizeY, cols, rows, leftPx, topPx };
}
