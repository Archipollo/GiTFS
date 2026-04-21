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

async function loadFeed(feedId: string): Promise<void> {
  const { beginMapTask, endMapTask, setMapTaskLabel, feeds } = useAppStore.getState();
  const taskId = `load-${feedId}`;
  const label = feeds[feedId]?.label ?? feedId;
  beginMapTask(taskId, `Loading ${label}…`);
  try {
    const stems = await listParquetStems(feedId);
    if (stems.length > 0) {
      setMapTaskLabel(taskId, `Restoring ${label} (parquet)…`);
      await loadFromParquet(feedId, stems);
      loaded.add(feedId);
      return;
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
      if (meta) metas.push(meta);
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
