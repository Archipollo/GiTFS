// OPFS persistence layer for GiTFS.
//
// Layout:
//   /feeds/<feedId>/raw.zip              original GTFS zip (always kept for fallback)
//   /feeds/<feedId>/meta.json            FeedMeta snapshot (so re-hydration skips re-ingest)
//   /feeds/<feedId>/shards/<stem>.parquet Columnar Parquet per GTFS table (stem = "stops", "routes", ...)

import type { FeedMeta } from '../state/app-store';

const ROOT = 'feeds';

async function rootDir(create = true): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    return null;
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create });
}

async function feedDir(feedId: string, create = true): Promise<FileSystemDirectoryHandle | null> {
  const root = await rootDir(create);
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(feedId, { create });
  } catch {
    return null;
  }
}

async function shardsDir(feedId: string, create = true): Promise<FileSystemDirectoryHandle | null> {
  const fd = await feedDir(feedId, create);
  if (!fd) return null;
  try {
    return await fd.getDirectoryHandle('shards', { create });
  } catch {
    return null;
  }
}

// ---- raw zip -------------------------------------------------------------

export async function putRaw(feedId: string, file: File): Promise<void> {
  const fd = await feedDir(feedId);
  if (!fd) return;
  const handle = await fd.getFileHandle('raw.zip', { create: true });
  const w = await handle.createWritable();
  await w.write(file);
  await w.close();
}

export async function getRaw(feedId: string): Promise<File | null> {
  const fd = await feedDir(feedId, false);
  if (!fd) return null;
  try {
    const handle = await fd.getFileHandle('raw.zip');
    return handle.getFile();
  } catch {
    return null;
  }
}

// ---- meta ----------------------------------------------------------------

export async function putMeta(feedId: string, meta: FeedMeta): Promise<void> {
  const fd = await feedDir(feedId);
  if (!fd) return;
  const handle = await fd.getFileHandle('meta.json', { create: true });
  const w = await handle.createWritable();
  await w.write(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  await w.close();
}

export async function getMeta(feedId: string): Promise<FeedMeta | null> {
  const fd = await feedDir(feedId, false);
  if (!fd) return null;
  try {
    const handle = await fd.getFileHandle('meta.json');
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as FeedMeta;
  } catch {
    return null;
  }
}

// ---- parquet shards ------------------------------------------------------

export async function putParquet(feedId: string, stem: string, bytes: Uint8Array): Promise<void> {
  const sd = await shardsDir(feedId);
  if (!sd) return;
  const handle = await sd.getFileHandle(`${stem}.parquet`, { create: true });
  const w = await handle.createWritable();
  // Force an ArrayBuffer-backed copy — DuckDB's output may be SharedArrayBuffer-backed,
  // which isn't a valid BlobPart under TS 5.6+.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  await w.write(buf);
  await w.close();
}

export async function getParquet(feedId: string, stem: string): Promise<Uint8Array | null> {
  const sd = await shardsDir(feedId, false);
  if (!sd) return null;
  try {
    const handle = await sd.getFileHandle(`${stem}.parquet`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function listParquetStems(feedId: string): Promise<string[]> {
  const sd = await shardsDir(feedId, false);
  if (!sd) return [];
  const stems: string[] = [];
  // @ts-expect-error — values() is async-iterable on FileSystemDirectoryHandle
  for await (const entry of sd.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.parquet')) {
      stems.push(entry.name.replace(/\.parquet$/, ''));
    }
  }
  return stems;
}

// ---- listing / removal ---------------------------------------------------

export async function listPersistedFeedIds(): Promise<string[]> {
  const root = await rootDir(false);
  if (!root) return [];
  const ids: string[] = [];
  // @ts-expect-error — values() is async-iterable on FileSystemDirectoryHandle
  for await (const entry of root.values()) {
    if (entry.kind === 'directory') ids.push(entry.name);
  }
  return ids;
}

export async function removeFeedFromOPFS(feedId: string): Promise<void> {
  const root = await rootDir(false);
  if (!root) return;
  await root.removeEntry(feedId, { recursive: true }).catch(() => {});
}
