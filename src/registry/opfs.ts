// OPFS persistence for the Entity Registry.
//
// Layout:
//   /registry/registry.json     serialized snapshot of the last build
//   /registry/overrides.json    user manual merge/unmerge directives

const ROOT = 'registry';

async function rootDir(create = true): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create });
}

async function readJson<T>(filename: string): Promise<T | null> {
  const dir = await rootDir(false);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJson(filename: string, data: unknown): Promise<void> {
  const dir = await rootDir(true);
  if (!dir) return;
  const handle = await dir.getFileHandle(filename, { create: true });
  const w = await handle.createWritable();
  await w.write(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  await w.close();
}

export const registryStore = {
  getSnapshot: <T>() => readJson<T>('registry.json'),
  putSnapshot: (data: unknown) => writeJson('registry.json', data),
  getOverrides: <T>() => readJson<T>('overrides.json'),
  putOverrides: (data: unknown) => writeJson('overrides.json', data),
  async clear(): Promise<void> {
    const dir = await rootDir(false);
    if (!dir) return;
    await dir.removeEntry('registry.json', { recursive: false }).catch(() => {});
    await dir.removeEntry('overrides.json', { recursive: false }).catch(() => {});
  },
};
