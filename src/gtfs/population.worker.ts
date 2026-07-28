// Web Worker for the population analysis layer: reads a windowed slice of a
// GHS-POP annual Cloud-Optimized GeoTIFF (see population.ts for the dataset
// and URL scheme) for a given bbox, off the main thread. The COG is served
// over HTTP with CORS + range-request support (verified against
// s3.openlandmap.org), so `geotiff.js` only pulls the bytes covering the
// requested window rather than the ~4GB whole-file.
//
// The annual COG's raw pixel values are NOT population count despite the
// dataset's `pop.count` name — they read ~100x the true per-cell population
// (see ANNUAL_DENSITY_TO_COUNT below for the investigation and correction).

import { fromArrayBuffer, fromUrl, type GeoTIFF } from 'geotiff';
import { BlobReader, Uint8ArrayWriter, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js';
import { cogUrlForYear, POPULATION_EPOCH_YEAR } from './population';

export interface PopulationGridRequest {
  id: number;
  year: number;
  /** [west, south, east, north] in WGS84 degrees. */
  bbox: [number, number, number, number];
}

export interface PopulationGridResponse {
  id: number;
  year: number;
  west: number;
  north: number;
  cellSizeX: number;
  cellSizeY: number;
  cols: number;
  rows: number;
  /** Row-major population count per cell (post-decimation — see cap below). */
  values: Float32Array;
}

// One decoded GeoTIFF per year, reused across requests for the session —
// opening is cheap (`fromUrl` just wraps the remote source; the expensive
// part is the windowed byte range fetch on each `readRasters` call).
const tiffCache = new Map<number, Promise<GeoTIFF>>();

function getTiff(year: number): Promise<GeoTIFF> {
  let p = tiffCache.get(year);
  if (!p) {
    p = fromUrl(cogUrlForYear(year)).catch((err) => {
      tiffCache.delete(year);
      throw err;
    });
    tiffCache.set(year, p);
  }
  return p;
}

// Hard cap on the decimated output grid so a country-scale bbox at low zoom
// still produces a renderable number of fill polygons (and a bounded
// `readRasters` decode/transfer cost) instead of millions of 100m cells.
const MAX_GRID_DIM = 220;

// Discrete tile-pyramid levels, in native ~92.5m GHS-POP pixels per output
// cell (1, 3, 5, 11, 27, 54, 108, 216 ≈ 100m/250m/500m/1km/2.5km/5km/10km/
// 20km cells). Picking cell size from this fixed set — rather than the
// continuous `nativeSpan / MAX_GRID_DIM` this used to compute — means
// panning/zooming a few pixels can't silently change what a cell physically
// covers: the map only ever renders one of a handful of known, labelable
// cell sizes, and two requests at similar zoom get the *same* cell size
// instead of two arbitrarily different ones. See `pickPyramidCellPx`.
const PYRAMID_CELL_PX_LEVELS: readonly number[] = [1, 3, 5, 11, 27, 54, 108, 216];

/** Picks the finest pyramid cell size (in native pixels) whose output grid
 * fits within MAX_GRID_DIM for a window spanning `nativeSpanPx` native
 * pixels — i.e. the tile-pyramid level the current viewport would use. */
function pickPyramidCellPx(nativeSpanPx: number): number {
  for (const level of PYRAMID_CELL_PX_LEVELS) {
    if (Math.ceil(nativeSpanPx / level) <= MAX_GRID_DIM) return level;
  }
  return PYRAMID_CELL_PX_LEVELS[PYRAMID_CELL_PX_LEVELS.length - 1];
}

// Cap on how many native pixels we'll ever decode in one dimension before
// aggregating down to MAX_GRID_DIM. GHS-POP stores population *count* per
// ~100m pixel, so collapsing many native pixels into one output cell must
// SUM them, not point-sample one (that's what geotiff.js's default
// 'nearest' resampleMethod does, and it silently discards almost every
// pixel's count — see population-loss bug write-up). At normal viewport
// scale the native window is well under this cap, so the decode is exact
// (scaleX/scaleY below come out to 1) and the sum is exact. Only an
// extreme zoomed-out bbox hits the cap, in which case we decode at this
// coarser-than-native resolution and scale the block sums up to estimate
// the true per-cell total.
const MAX_DECODE_DIM = MAX_GRID_DIM * 10;

interface GeoImageLike {
  readRasters(options: {
    window: [number, number, number, number];
    width: number;
    height: number;
    samples: number[];
    fillValue: number;
  }): Promise<ArrayLike<number>[] | { width: number; height: number }>;
}

/** Decodes a native-pixel window, capped at MAX_DECODE_DIM per side so an
 * extreme bbox can't blow up worker memory. Returns how many native pixels
 * each decoded pixel stands in for (scaleX/scaleY, both 1 in the common
 * case) so callers can scale block sums back up to a true total. */
async function readWindowForSum(
  image: GeoImageLike,
  window: [number, number, number, number],
): Promise<{ values: Float32Array; w: number; h: number; scaleX: number; scaleY: number }> {
  const [left, top, right, bottom] = window;
  const nativeW = right - left;
  const nativeH = bottom - top;
  const w = Math.min(nativeW, MAX_DECODE_DIM);
  const h = Math.min(nativeH, MAX_DECODE_DIM);
  const rasters = await image.readRasters({ window, width: w, height: h, samples: [0], fillValue: 0 });
  const values = Float32Array.from((rasters as ArrayLike<number>[])[0]);
  return { values, w, h, scaleX: nativeW / w, scaleY: nativeH / h };
}

/** Sums a decoded pixel grid into a coarser outW x outH grid (box
 * downsampling by summation, not averaging — population count is
 * additive). `scale` compensates for MAX_DECODE_DIM having forced a
 * coarser-than-native decode (1 in the common case, see readWindowForSum). */
function aggregateSum(
  src: Float32Array,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  scale: number,
): Float32Array {
  const dest = new Float32Array(outW * outH);
  for (let sy = 0; sy < srcH; sy++) {
    const dy = Math.min(outH - 1, Math.floor((sy * outH) / srcH));
    const rowOffset = sy * srcW;
    const destRowOffset = dy * outW;
    for (let sx = 0; sx < srcW; sx++) {
      const dx = Math.min(outW - 1, Math.floor((sx * outW) / srcW));
      dest[destRowOffset + dx] += src[rowOffset + sx];
    }
  }
  if (scale !== 1) {
    for (let i = 0; i < dest.length; i++) dest[i] *= scale;
  }
  return dest;
}

// OpenLandMap's annual COG (2000-2021) is NOT population count per pixel
// despite its `pop.count` name — confirmed by point-sampling dozens of
// coordinates against the official JRC GHS-POP 2025 epoch tile (a real
// count) and comparing regional sums: every sampled pixel here reads ~100x
// the true per-cell population the 2025 tile reports at the same spot (e.g.
// Vienna center: this source's 2021 pixel is 10475, the 2025 tile's is
// 103.7; a ~20M-person rectangle around Austria sums to ~2.2 BILLION here vs
// ~20M in the 2025 tile). Left uncorrected, the annual series reads two
// orders of magnitude too high, which is what produced an apparent ~99%
// population collapse everywhere between 2021 and 2025 in the diff overlay
// — the real numbers were never that different, this source's units just
// don't match a true per-cell count. Applying this factor brings the annual
// series in line with the 2025 tile's real counts and restores a plausible,
// gently-increasing trend across 2000/2020/2021/2025 at the same pixel.
const ANNUAL_DENSITY_TO_COUNT = 1 / 100;

// Canonical pixel lattice shared by both the annual COG series and the 2025
// epoch tiles — both are the same underlying GHS-POP grid to within about a
// pixel (empirically confirmed), and these constants are hardcoded from the
// OpenLandMap COG's own GeoTIFF header. Windowing both paths off this same
// origin/pixel-size (rather than each image's own bounding box/dimensions)
// guarantees a given bbox produces an identical pixel window — same left/
// top/right/bottom, same output grid shape — regardless of which path
// resolves it, which the diff view depends on for its cell-index-aligned
// per-cell delta between a pre-2022 and a 2025 grid (see diff/population.ts).
const GRID_ORIGIN_LON = -180.00041593133002;
const GRID_ORIGIN_LAT = 89.09208317767579;
const GRID_PX_PER_DEG = 1 / 0.0008333333300327;

async function readPopulationGrid(req: PopulationGridRequest): Promise<PopulationGridResponse> {
  const tiff = await getTiff(req.year);
  const image = await tiff.getImage();
  const [imgWest, imgSouth, imgEast, imgNorth] = image.getBoundingBox();
  const imgWidth = image.getWidth();
  const imgHeight = image.getHeight();

  const [reqWest, reqSouth, reqEast, reqNorth] = req.bbox;
  const clampedWest = Math.max(reqWest, imgWest);
  const clampedEast = Math.min(reqEast, imgEast);
  const clampedSouth = Math.max(reqSouth, imgSouth);
  const clampedNorth = Math.min(reqNorth, imgNorth);

  // Snap onto the same canonical pixel lattice the 2025 epoch path uses (see
  // GRID_ORIGIN_*/GRID_PX_PER_DEG below), instead of deriving pixel size from
  // this image's own bounding box/dimensions and floor/ceil-ing the window.
  // Both sources are documented as the same underlying GHS-POP grid, but a
  // per-image division (floating-point noise) plus floor/ceil vs round can
  // each shift the window by a pixel — which silently breaks the diff view's
  // assumption that an annual-source grid and an epoch-source grid for the
  // same bbox line up cell-for-cell (see diff/population.ts).
  const imgLeftPx = Math.round((imgWest - GRID_ORIGIN_LON) * GRID_PX_PER_DEG);
  const imgTopPx = Math.round((GRID_ORIGIN_LAT - imgNorth) * GRID_PX_PER_DEG);

  const globalLeft = Math.round((clampedWest - GRID_ORIGIN_LON) * GRID_PX_PER_DEG);
  const globalRight = Math.round((clampedEast - GRID_ORIGIN_LON) * GRID_PX_PER_DEG);
  const globalTop = Math.round((GRID_ORIGIN_LAT - clampedNorth) * GRID_PX_PER_DEG);
  const globalBottom = Math.round((GRID_ORIGIN_LAT - clampedSouth) * GRID_PX_PER_DEG);

  const left = Math.max(0, globalLeft - imgLeftPx);
  const right = Math.min(imgWidth, globalRight - imgLeftPx);
  const top = Math.max(0, globalTop - imgTopPx);
  const bottom = Math.min(imgHeight, globalBottom - imgTopPx);

  if (right <= left || bottom <= top) {
    return { id: req.id, year: req.year, west: clampedWest, north: clampedNorth, cellSizeX: 0, cellSizeY: 0, cols: 0, rows: 0, values: new Float32Array(0) };
  }

  const cellPx = pickPyramidCellPx(Math.max(right - left, bottom - top));
  const outW = Math.min(MAX_GRID_DIM, Math.ceil((right - left) / cellPx));
  const outH = Math.min(MAX_GRID_DIM, Math.ceil((bottom - top) / cellPx));

  const west = GRID_ORIGIN_LON + (imgLeftPx + left) / GRID_PX_PER_DEG;
  const east = GRID_ORIGIN_LON + (imgLeftPx + right) / GRID_PX_PER_DEG;
  const north = GRID_ORIGIN_LAT - (imgTopPx + top) / GRID_PX_PER_DEG;
  const south = GRID_ORIGIN_LAT - (imgTopPx + bottom) / GRID_PX_PER_DEG;

  const { values: decoded, w: dw, h: dh, scaleX, scaleY } = await readWindowForSum(image as GeoImageLike, [
    left,
    top,
    right,
    bottom,
  ]);
  const values = aggregateSum(decoded, dw, dh, outW, outH, scaleX * scaleY * ANNUAL_DENSITY_TO_COUNT);

  return {
    id: req.id,
    year: req.year,
    west,
    north,
    cellSizeX: (east - west) / outW,
    cellSizeY: (north - south) / outH,
    cols: outW,
    rows: outH,
    values,
  };
}

// ---- JRC GHSL 2025 epoch tiles (proxied; official R2023A release) --------
//
// OpenLandMap's annual COG series only runs 2000-2021 (verified: querying
// 2022+ 404s). The JRC GHSL R2023A release additionally ships a real 2025
// projection epoch, but only as 429 per-tile zips with no CORS headers on
// jeodpp.jrc.ec.europa.eu — unusable directly from a browser. The app's own
// Worker (worker.ts in production, a Vite dev-server proxy locally) re-serves
// those zips same-origin at `/api/ghsl-tile/2025/R{row}_C{col}.zip`; this
// fetches the tile(s) covering a bbox, unzips them (zip.js, same library
// used for GTFS ingest — see gtfs/ingest.ts), and reads windowed rasters.
//
// Each tile is a fixed 10°x10° WGS84 slice at the same ~3-arcsec
// (1/1200-degree) pixel size as the OpenLandMap COG (empirically confirmed:
// both are the same underlying GHS-POP grid to within about a pixel) — see
// GRID_ORIGIN_*/GRID_PX_PER_DEG above.

const EPOCH_TILE_SIZE_DEG = 10;
// West edge of tile column 19 / north edge of tile row 6, read off that
// tile's own GeoTIFF header (gdalinfo), used to derive every other tile's
// bounds via the fixed 10-degree step.
const EPOCH_REF_LON = -0.0079166442387759;
const EPOCH_REF_COL = 19;
const EPOCH_REF_LAT = 39.099583378875366;
const EPOCH_REF_ROW = 6;

function tileColForLon(lon: number): number {
  return Math.floor((lon - EPOCH_REF_LON) / EPOCH_TILE_SIZE_DEG) + EPOCH_REF_COL;
}

function tileRowForLat(lat: number): number {
  return Math.floor((EPOCH_REF_LAT - lat) / EPOCH_TILE_SIZE_DEG) + EPOCH_REF_ROW;
}

function epochTileUrl(row: number, col: number): string {
  return `/api/ghsl-tile/2025/R${row}_C${col}.zip`;
}

// One decoded (unzipped) GeoTIFF per tile, reused across requests for the
// session. `null` caches a confirmed-absent tile (JRC's tile grid is sparse
// — mostly-ocean cells don't exist) so repeated requests near a coverage
// edge don't refetch a 404 every time.
const epochTiffCache = new Map<string, Promise<GeoTIFF | null>>();

function getEpochTile(row: number, col: number): Promise<GeoTIFF | null> {
  const key = `${row}_${col}`;
  let p = epochTiffCache.get(key);
  if (!p) {
    p = fetchEpochTile(row, col);
    epochTiffCache.set(key, p);
  }
  return p;
}

async function fetchEpochTile(row: number, col: number): Promise<GeoTIFF | null> {
  const res = await fetch(epochTileUrl(row, col));
  if (!res.ok) return null;
  const zipReader = new ZipReader(new BlobReader(await res.blob()));
  try {
    const entries: Entry[] = await zipReader.getEntries();
    const tifEntry = entries.find(
      (entry) => !entry.directory && entry.filename.toLowerCase().endsWith('.tif'),
    ) as FileEntry | undefined;
    if (!tifEntry?.getData) return null;
    const bytes = await tifEntry.getData(new Uint8ArrayWriter());
    return await fromArrayBuffer(bytes.buffer as ArrayBuffer);
  } finally {
    await zipReader.close();
  }
}

async function readEpochPopulationGrid(req: PopulationGridRequest): Promise<PopulationGridResponse> {
  const [reqWest, reqSouth, reqEast, reqNorth] = req.bbox;

  // Snap the requested bbox onto the canonical pixel lattice.
  const left = Math.round((reqWest - GRID_ORIGIN_LON) * GRID_PX_PER_DEG);
  const right = Math.round((reqEast - GRID_ORIGIN_LON) * GRID_PX_PER_DEG);
  const top = Math.round((GRID_ORIGIN_LAT - reqNorth) * GRID_PX_PER_DEG);
  const bottom = Math.round((GRID_ORIGIN_LAT - reqSouth) * GRID_PX_PER_DEG);

  if (right <= left || bottom <= top) {
    return {
      id: req.id,
      year: POPULATION_EPOCH_YEAR,
      west: reqWest,
      north: reqNorth,
      cellSizeX: 0,
      cellSizeY: 0,
      cols: 0,
      rows: 0,
      values: new Float32Array(0),
    };
  }

  const cellPx = pickPyramidCellPx(Math.max(right - left, bottom - top));
  const outW = Math.min(MAX_GRID_DIM, Math.ceil((right - left) / cellPx));
  const outH = Math.min(MAX_GRID_DIM, Math.ceil((bottom - top) / cellPx));
  const factor = cellPx; // native px per output px (>= 1), from the same pyramid level as readPopulationGrid

  const west = GRID_ORIGIN_LON + left / GRID_PX_PER_DEG;
  const north = GRID_ORIGIN_LAT - top / GRID_PX_PER_DEG;
  const east = GRID_ORIGIN_LON + right / GRID_PX_PER_DEG;
  const south = GRID_ORIGIN_LAT - bottom / GRID_PX_PER_DEG;
  const cellSizeX = (east - west) / outW;
  const cellSizeY = (north - south) / outH;

  const values = new Float32Array(outW * outH);

  const colFrom = tileColForLon(west);
  const colTo = tileColForLon(east - 1e-9);
  const rowFrom = tileRowForLat(north - 1e-9);
  const rowTo = tileRowForLat(south);

  for (let row = rowFrom; row <= rowTo; row++) {
    for (let col = colFrom; col <= colTo; col++) {
      const tiff = await getEpochTile(row, col);
      if (!tiff) continue;
      const image = await tiff.getImage();
      const imgWidth = image.getWidth();
      const imgHeight = image.getHeight();
      const [imgWest, imgSouth, imgEast, imgNorth] = image.getBoundingBox();
      const pxPerDegX = imgWidth / (imgEast - imgWest);
      const pxPerDegY = imgHeight / (imgNorth - imgSouth);

      // Overlap between the requested (global-lattice) window and this
      // tile, in geographic coordinates.
      const oWest = Math.max(west, imgWest);
      const oEast = Math.min(east, imgEast);
      const oNorth = Math.min(north, imgNorth);
      const oSouth = Math.max(south, imgSouth);
      if (oEast <= oWest || oNorth <= oSouth) continue;

      const tLeft = Math.max(0, Math.floor((oWest - imgWest) * pxPerDegX));
      const tRight = Math.min(imgWidth, Math.ceil((oEast - imgWest) * pxPerDegX));
      const tTop = Math.max(0, Math.floor((imgNorth - oNorth) * pxPerDegY));
      const tBottom = Math.min(imgHeight, Math.ceil((imgNorth - oSouth) * pxPerDegY));
      if (tRight <= tLeft || tBottom <= tTop) continue;

      // Where this overlap's top-left lands in the global output grid.
      const outLeft = Math.max(0, Math.round((imgWest + tLeft / pxPerDegX - west) / cellSizeX));
      const outTop = Math.max(0, Math.round((north - (imgNorth - tTop / pxPerDegY)) / cellSizeY));

      // Decode at (up to) native resolution and SUM each native pixel into
      // its output cell — population count is additive, so a decimated
      // cell's value must be the total of the native pixels it covers, not
      // one point-sampled pixel (that undercounts and, worse, makes a
      // cell's value depend on which single native pixel a resample
      // happened to land on — see population-loss bug write-up).
      const { values: tileDecoded, w: dw, h: dh, scaleX, scaleY } = await readWindowForSum(image as GeoImageLike, [
        tLeft,
        tTop,
        tRight,
        tBottom,
      ]);
      const perPixelCount = scaleX * scaleY; // native pixels each decoded pixel stands in for
      for (let ty = 0; ty < dh; ty++) {
        // Native-pixel row/col offset (from this tile's window origin),
        // converted to a global output-grid cell via `factor` (native px
        // per output px, shared by the whole request lattice).
        const destRow = outTop + Math.floor((ty * scaleY) / factor);
        if (destRow < 0 || destRow >= outH) continue;
        const destRowOffset = destRow * outW;
        const rowOffset = ty * dw;
        for (let tx = 0; tx < dw; tx++) {
          const destCol = outLeft + Math.floor((tx * scaleX) / factor);
          if (destCol < 0 || destCol >= outW) continue;
          values[destRowOffset + destCol] += tileDecoded[rowOffset + tx] * perPixelCount;
        }
      }
    }
  }

  return { id: req.id, year: POPULATION_EPOCH_YEAR, west, north, cellSizeX, cellSizeY, cols: outW, rows: outH, values };
}

self.onmessage = (e: MessageEvent<PopulationGridRequest>) => {
  const handler = e.data.year === POPULATION_EPOCH_YEAR ? readEpochPopulationGrid : readPopulationGrid;
  handler(e.data)
    .then((res) => {
      (self as unknown as Worker).postMessage(res, [res.values.buffer]);
    })
    .catch((err) => {
      (self as unknown as Worker).postMessage({ id: e.data.id, error: String(err?.message ?? err) });
    });
};
