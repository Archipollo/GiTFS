import {
  BlobReader,
  type FileEntry,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
} from '@zip.js/zip.js';
import { getDuckDB, getConnection } from './duckdb';
import { useAppStore, type FeedMeta } from '../state/app-store';
import { putRaw, putMeta, putParquet } from './opfs';
import { markFeedLoaded } from './feed-loader';
import { buildFeedLabel } from '../timeline/math';

// GTFS files we care about. Others (fares_*, translations, etc.) are skipped.
const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'shapes.txt',
  'feed_info.txt',
] as const;

export type GtfsFileName = (typeof GTFS_FILES)[number];

export interface IngestOptions {
  /** Reuse a given feedId instead of deriving a new one. Used by re-hydration from raw.zip. */
  reuseId?: string;
  /** Do not push the resulting meta into the app store. */
  skipStore?: boolean;
  /** Persist the raw zip to OPFS (default: true). */
  persistRaw?: boolean;
  /** Transcode each table to Parquet in OPFS (default: true). */
  persistParquet?: boolean;
}

function feedIdFromName(name: string): string {
  const base = name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `${base}_${Date.now().toString(36)}`;
}

function tableStem(file: GtfsFileName): string {
  return file.replace(/\.txt$/, '');
}

export function qualifiedTable(feedId: string, file: GtfsFileName): string {
  return `"${feedId}__${tableStem(file)}"`;
}

export async function ingestGtfsZip(file: File, opts: IngestOptions = {}): Promise<FeedMeta> {
  const { setIngesting, addFeed } = useAppStore.getState();
  const feedId = opts.reuseId ?? feedIdFromName(file.name);
  const persistRaw = opts.persistRaw !== false;
  const persistParquet = opts.persistParquet !== false;

  setIngesting({ id: feedId, progress: 'reading zip' });

  try {
    const zipReader = new ZipReader(new BlobReader(file));
    const zipEntries = await zipReader.getEntries();
    const db = await getDuckDB();
    const conn = await getConnection();
    try {

    if (persistRaw) {
      // fire-and-forget — the zip is nice to have but non-blocking
      putRaw(feedId, file).catch((err) => console.warn('OPFS putRaw failed', err));
    }

    const present: GtfsFileName[] = [];
    for (const name of GTFS_FILES) {
      const entry = pickZipEntry(zipEntries, name);
      if (!entry) continue;

      setIngesting({ id: feedId, progress: `parsing ${name}` });
      const bytes = await entry.getData!(new Uint8ArrayWriter());
      const csvBytes = stripUtf8Bom(bytes);
      const csvVirtualPath = `${feedId}/${name}`;
      await db.registerFileBuffer(csvVirtualPath, csvBytes);

      const table = qualifiedTable(feedId, name);
      await conn.query(buildCreateSql(table, csvVirtualPath, name));
      // CSV payload now lives in the table; drop the virtual text to free memory.
      await db.dropFile(csvVirtualPath).catch(() => {});

      if (persistParquet) {
        setIngesting({ id: feedId, progress: `shard ${name}` });
        await transcodeTableToParquet(conn, db, feedId, name);
      }
      present.push(name);
    }
      if (!present.includes('stops.txt')) {
        throw new Error('Zip does not contain stops.txt — not a GTFS feed?');
      }

      setIngesting({ id: feedId, progress: 'computing summary' });
      const counts = await readCounts(conn, feedId, present);
      const [feedStartDate, feedEndDate] = await readFeedDates(conn, feedId, present);

      const loadedAt = Date.now();
      const label = buildFeedLabel(file.name, feedStartDate, feedEndDate, loadedAt);
      const meta: FeedMeta = {
        id: feedId,
        label,
        sourceName: file.name,
        loadedAt,
        stopCount: counts.stops,
        routeCount: counts.routes,
        tripCount: counts.trips,
        feedStartDate,
        feedEndDate,
      };

      if (persistParquet) {
        putMeta(feedId, meta).catch((err) => console.warn('OPFS putMeta failed', err));
      }

      markFeedLoaded(feedId);
      if (!opts.skipStore) addFeed(meta);
      return meta;
    } finally {
      await conn.close().catch(() => {});
      await zipReader.close().catch(() => {});
    }
  } finally {
    setIngesting(null);
  }
}

function pickZipEntry(entries: Entry[], name: GtfsFileName): FileEntry | null {
  const needle = name.toLowerCase();
  const match = entries.find((entry) => {
    if (entry.directory) return false;
    const filename = entry.filename.toLowerCase();
    return filename === needle || filename.endsWith(`/${needle}`);
  });
  if (!match || match.directory) return null;
  return match as FileEntry;
}

function buildCreateSql(table: string, csvVirtualPath: string, name: GtfsFileName): string {
  const src = `read_csv_auto('${csvVirtualPath}', header=true, all_varchar=true)`;
  switch (name) {
    // Small tables — keep everything as varchar so downstream queries can pick
    // whichever optional columns exist (e.g. route_short_name, agency_id, stop_code).
    case 'agency.txt':
    case 'stops.txt':
    case 'routes.txt':
    case 'trips.txt':
    case 'calendar.txt':
    case 'feed_info.txt':
      return `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${src};`;
    // Large tables — narrow projection for speed and memory.
    case 'stop_times.txt':
      return `
        CREATE OR REPLACE TABLE ${table} AS
        SELECT stop_id, trip_id, stop_sequence
        FROM ${src};
      `;
    case 'shapes.txt':
      return `
        CREATE OR REPLACE TABLE ${table} AS
        SELECT shape_id, shape_pt_lon, shape_pt_lat, shape_pt_sequence
        FROM ${src};
      `;
    default:
      return `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${src};`;
  }
}

// Tables without which a feed is unusable. If transcoding one of these fails
// we cannot silently continue — the feed would look fine until the first
// registry build or map open, at which point DuckDB errors out from deep
// inside a SELECT with a cryptic "table does not exist" message.
const CRITICAL_GTFS_FILES: ReadonlySet<GtfsFileName> = new Set([
  'stops.txt',
  'routes.txt',
  'trips.txt',
]);

async function transcodeTableToParquet(
  conn: Awaited<ReturnType<typeof getConnection>>,
  db: Awaited<ReturnType<typeof getDuckDB>>,
  feedId: string,
  name: GtfsFileName,
) {
  const stem = tableStem(name);
  const virtualPath = `${feedId}/${stem}.parquet`;
  try {
    // Pre-register the output path so DuckDB doesn't log a "Buffering missing file" warning.
    await db.registerEmptyFileBuffer(virtualPath);
    await conn.query(`
      COPY ${qualifiedTable(feedId, name)}
      TO '${virtualPath}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `);
    const bytes = await db.copyFileToBuffer(virtualPath);
    await putParquet(feedId, stem, bytes);
  } catch (err) {
    if (CRITICAL_GTFS_FILES.has(name)) {
      throw new Error(
        `Failed to write ${name} parquet shard: ${err instanceof Error ? err.message : String(err)}. ` +
          `This table is required; aborting ingest so the feed isn't left half-persisted.`,
      );
    }
    console.warn(`parquet transcode failed for ${name}`, err);
  } finally {
    await db.dropFile(virtualPath).catch(() => {});
  }
}

function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

async function readCounts(
  conn: Awaited<ReturnType<typeof getConnection>>,
  feedId: string,
  present: GtfsFileName[],
) {
  const count = async (file: GtfsFileName) => {
    if (!present.includes(file)) return undefined;
    const res = await conn.query(`SELECT count(*)::INTEGER AS n FROM ${qualifiedTable(feedId, file)}`);
    const row = res.toArray()[0] as { n: number };
    return row.n;
  };
  return {
    stops: await count('stops.txt'),
    routes: await count('routes.txt'),
    trips: await count('trips.txt'),
  };
}

async function readFeedDates(
  conn: Awaited<ReturnType<typeof getConnection>>,
  feedId: string,
  present: GtfsFileName[],
): Promise<[string | undefined, string | undefined]> {
  if (present.includes('feed_info.txt')) {
    const r = await conn.query(
      `SELECT feed_start_date, feed_end_date FROM ${qualifiedTable(feedId, 'feed_info.txt')} LIMIT 1`,
    );
    const row = r.toArray()[0] as { feed_start_date?: string; feed_end_date?: string } | undefined;
    if (row?.feed_start_date || row?.feed_end_date) {
      return [row?.feed_start_date, row?.feed_end_date];
    }
  }
  if (present.includes('calendar.txt')) {
    const r = await conn.query(
      `SELECT min(start_date) AS s, max(end_date) AS e FROM ${qualifiedTable(feedId, 'calendar.txt')}`,
    );
    const row = r.toArray()[0] as { s?: string; e?: string };
    return [row?.s, row?.e];
  }
  return [undefined, undefined];
}
