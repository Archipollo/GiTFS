import * as duckdb from '@duckdb/duckdb-wasm';

/** Own OPFS subtree — must not collide with GiTFS `feeds/` layout in `opfs.ts`. */
const OPFS_NS = '_gitfs_duckdb';
const OPFS_DB = `opfs://${OPFS_NS}/session.duckdb`;
/** Directory path for spilling (no trailing slash; DuckDB adds temp file names). */
const OPFS_TEMP = `opfs://${OPFS_NS}/tmp`;

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let openedWithOpfs = false;

export function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

function canUseOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemDirectoryHandle !== 'undefined' &&
    typeof FileSystemDirectoryHandle.prototype.removeEntry === 'function'
  );
}

/** Remove prior session DB + spill files so reload does not resurrect stale tables. */
async function resetOpfsNamespace(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_NS, { recursive: true });
  } catch {
    // Missing directory is expected on first run.
  }
}

/**
 * DuckDB-WASM does not mkdir OPFS paths used for `temp_directory`; they must exist first.
 * Call again before each connection so spill cleanup cannot leave the next ingest without tmp.
 */
async function ensureOpfsDuckdbLayout(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const ns = await root.getDirectoryHandle(OPFS_NS, { create: true });
  await ns.getDirectoryHandle('tmp', { create: true });
}

async function init(): Promise<duckdb.AsyncDuckDB> {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  if (canUseOpfs()) {
    try {
      await resetOpfsNamespace();
      await ensureOpfsDuckdbLayout();
      await db.open({
        path: OPFS_DB,
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        // "auto" unregisters opfs:// paths after each statement; that tears down the
        // temp_directory pool right after SET temp_directory, so spills fail with
        // File not found on opfs://.../tmp. "manual" keeps OPFS registrations alive.
        opfs: { fileHandling: 'manual' },
      });
      openedWithOpfs = true;
    } catch (err) {
      console.warn('[duckdb] OPFS-backed open failed; using default in-memory instance', err);
    }
  }

  return db;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

/** Tune each session: less RAM per op, spill to OPFS when available. */
async function applySessionSettings(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
  await conn.query('SET preserve_insertion_order=false;');
  // Do not SET threads / maximumThreads here: the MVP WASM build has no pthreads;
  // changing thread count triggers "compiled without threads" errors.
  if (openedWithOpfs) {
    await ensureOpfsDuckdbLayout();
    await conn.query(`SET temp_directory='${escapeSqlString(OPFS_TEMP)}';`);
  }
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  const db = await getDuckDB();
  const conn = await db.connect();
  await applySessionSettings(conn);
  return conn;
}
