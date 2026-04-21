import JSZip from 'jszip';
import { getDuckDB, getConnection } from './duckdb';
import { useAppStore, type FeedMeta } from '../state/app-store';
import { putRaw, putMeta, putParquet } from './opfs';
import { markFeedLoaded } from './feed-loader';

// GTFS files we care about in M1. Others (fares_*, translations, etc.) are skipped.
const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'frequencies.txt',
  'transfers.txt',
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
    const zip = await JSZip.loadAsync(file);
    const db = await getDuckDB();
    const conn = await getConnection();

    if (persistRaw) {
      // fire-and-forget — the zip is nice to have but non-blocking
      putRaw(feedId, file).catch((err) => console.warn('OPFS putRaw failed', err));
    }

    const present: GtfsFileName[] = [];
    for (const name of GTFS_FILES) {
      const entry =
        zip.file(name) ??
        zip.file(new RegExp(`(^|/)${name}$`, 'i'))?.[0] ??
        null;
      if (!entry) continue;

      setIngesting({ id: feedId, progress: `parsing ${name}` });
      const text = stripBom(await entry.async('string'));
      const csvVirtualPath = `${feedId}/${name}`;
      await db.registerFileText(csvVirtualPath, text);

      const table = qualifiedTable(feedId, name);
      await conn.query(`
        CREATE OR REPLACE TABLE ${table} AS
        SELECT * FROM read_csv_auto('${csvVirtualPath}', header=true, all_varchar=true);
      `);
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

    await conn.close();

    const label = deriveLabel(file.name, feedStartDate);
    const meta: FeedMeta = {
      id: feedId,
      label,
      sourceName: file.name,
      loadedAt: Date.now(),
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
    setIngesting(null);
  }
}

async function transcodeTableToParquet(
  conn: Awaited<ReturnType<typeof getConnection>>,
  db: Awaited<ReturnType<typeof getDuckDB>>,
  feedId: string,
  name: GtfsFileName,
) {
  const stem = tableStem(name);
  const virtualPath = `${feedId}/${stem}.parquet`;
  try {
    await conn.query(`
      COPY ${qualifiedTable(feedId, name)}
      TO '${virtualPath}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `);
    const bytes = await db.copyFileToBuffer(virtualPath);
    await putParquet(feedId, stem, bytes);
  } catch (err) {
    console.warn(`parquet transcode failed for ${name}`, err);
  } finally {
    await db.dropFile(virtualPath).catch(() => {});
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function deriveLabel(sourceName: string, feedStart?: string): string {
  const stem = sourceName.replace(/\.zip$/i, '');
  if (feedStart) return `${stem} (${feedStart.slice(0, 4)})`;
  return stem;
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
