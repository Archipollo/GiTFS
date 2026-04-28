// Lazy loader for per-feed DuckDB tables. Tracks which feeds already have their
// tables hydrated in the in-memory DuckDB instance. Prefers Parquet shards (fast)
// over re-ingesting the raw zip (slow).

import { getDuckDB, getConnection } from './duckdb';
import {
  listPersistedFeedIds,
  getMeta,
  getParquet,
  listParquetStems,
  getRaw,
} from './opfs';
import { useAppStore, type FeedMeta } from '../state/app-store';
import { buildFeedLabel } from '../timeline/math';

const loaded = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

export function markFeedLoaded(feedId: string): void {
  loaded.add(feedId);
}

export function isFeedLoaded(feedId: string): boolean {
  return loaded.has(feedId);
}

export function ensureFeedTablesLoaded(feedId: string): Promise<void> {
  if (loaded.has(feedId)) return Promise.resolve();
  const existing = inFlight.get(feedId);
  if (existing) return existing;
  const p = loadFeed(feedId).finally(() => inFlight.delete(feedId));
  inFlight.set(feedId, p);
  return p;
}

// Tables we consider mandatory for a feed to be usable. Missing `stops` is
// fatal for registry builds, map rendering, and basically everything. Missing
// `routes` / `trips` are almost as bad.
const REQUIRED_STEMS = ['stops', 'routes', 'trips'] as const;

async function loadFeed(feedId: string): Promise<void> {
  const { beginMapTask, endMapTask, setMapTaskLabel, feeds } = useAppStore.getState();
  const taskId = `load-${feedId}`;
  const label = feeds[feedId]?.label ?? feedId;
  beginMapTask(taskId, `Loading ${label}…`);
  try {
    const stems = await listParquetStems(feedId);
    const missing = REQUIRED_STEMS.filter((s) => !stems.includes(s));
    if (stems.length > 0 && missing.length === 0) {
      setMapTaskLabel(taskId, `Restoring ${label} (parquet)…`);
      await loadFromParquet(feedId, stems);
      loaded.add(feedId);
      return;
    }
    if (stems.length > 0) {
      console.warn(
        `[feed-loader] ${feedId} parquet shards incomplete (missing: ${missing.join(', ')}); falling back to raw zip`,
      );
    }
    const raw = await getRaw(feedId);
    if (raw) {
      setMapTaskLabel(taskId, `Re-ingesting ${label} from zip…`);
      // Lazy import to avoid an ingest <-> feed-loader cycle at module load time.
      const { ingestGtfsZip } = await import('./ingest');
      await ingestGtfsZip(raw, {
        reuseId: feedId,
        skipStore: true,
        persistRaw: false,
        persistParquet: true,
      });
      loaded.add(feedId);
      return;
    }
    if (stems.length > 0) {
      throw new Error(
        `Feed ${feedId} has incomplete Parquet shards (missing ${missing.join(', ')}) and no raw zip to re-ingest from. ` +
          `Remove the feed and re-upload its GTFS zip.`,
      );
    }
    throw new Error(`Feed ${feedId} has no persisted Parquet shards or raw zip`);
  } finally {
    endMapTask(taskId);
  }
}

async function loadFromParquet(feedId: string, stems: string[]): Promise<void> {
  const db = await getDuckDB();
  const conn = await getConnection();
  try {
    for (const stem of stems) {
      const bytes = await getParquet(feedId, stem);
      if (!bytes) continue;
      const virtualPath = `hydrate/${feedId}/${stem}.parquet`;
      await db.registerFileBuffer(virtualPath, bytes);
      await conn.query(`
        CREATE OR REPLACE TABLE "${feedId}__${stem}" AS
        SELECT * FROM read_parquet('${virtualPath}');
      `);
      // Keep the file registered so re-reads work if needed; DuckDB table already owns the data.
    }
  } finally {
    await conn.close();
  }
}

// ---- boot --------------------------------------------------------------

let booted = false;

export async function rehydrateOnBoot(): Promise<void> {
  if (booted) return;
  booted = true;
  const store = useAppStore.getState();
  const taskId = 'boot-rehydrate';
  store.beginMapTask(taskId, 'Restoring saved feeds…');
  try {
    const ids = await listPersistedFeedIds();
    const metas: FeedMeta[] = [];
    for (const id of ids) {
      const meta = await getMeta(id);
      if (!meta) continue;
      // Re-derive the label so feeds ingested by older builds pick up fixes to
      // year derivation without needing a re-upload. We do NOT persist this
      // back to OPFS — the next fresh ingest will write the corrected label.
      metas.push({
        ...meta,
        label: buildFeedLabel(meta.sourceName, meta.feedStartDate, meta.feedEndDate, meta.loadedAt),
      });
    }
    // Earliest-loaded feed first, so it becomes the default active.
    metas.sort((a, b) => a.loadedAt - b.loadedAt);
    for (const meta of metas) store.addFeed(meta);
  } catch (err) {
    console.warn('rehydrate failed', err);
  } finally {
    store.endMapTask(taskId);
  }
}
