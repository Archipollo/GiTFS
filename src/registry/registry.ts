// Entity Registry orchestrator.
//
// Builds cross-feed canonical IDs for stops and routes, keeps an in-memory
// snapshot, persists to OPFS, and applies user override directives. The
// matchers themselves are pure functions in `stops-matcher.ts` / `routes-matcher.ts`.
//
// External callers should use `buildRegistry`, `getRegistry`, `subscribeRegistry`,
// and the lookup helpers. The React layer consumes these via a hook in
// `useRegistry.ts`.

import { useAppStore, type FeedMeta } from '../state/app-store';
import { fetchRawRoutes, fetchRawStops } from './queries';
import {
  matchStops,
  type CanonicalStop,
  type RawStop,
  type StopMatchResult,
} from './stops-matcher';
import {
  matchRoutes,
  type CanonicalRoute,
  type RawRoute,
  type RouteMatchResult,
} from './routes-matcher';
import { registryStore } from './opfs';

/** Snapshot of the registry — what we hand to UI consumers. */
export interface RegistrySnapshot {
  version: number;
  builtAt: number;
  /** `${feedId}\t${rawId}` -> canonical id */
  stopAssignments: Record<string, string>;
  routeAssignments: Record<string, string>;
  stops: Record<string, CanonicalStop>;
  routes: Record<string, CanonicalRoute>;
  /** canonical id -> members for drill-in */
  stopMembers: Record<string, RawStop[]>;
  routeMembers: Record<string, RawRoute[]>;
  /** Feeds that contributed to this build. */
  feedIds: string[];
}

const CURRENT_VERSION = 1;

/** User overrides applied after the automatic match. */
export interface RegistryOverrides {
  version: number;
  /**
   * Explicitly merge raw entities into a shared canonical id. Each entry lists
   * two or more members that should share the same canonical stop.
   */
  mergeStops: Array<{ members: Array<{ feedId: string; rawId: string }>; label?: string }>;
  mergeRoutes: Array<{ members: Array<{ feedId: string; rawId: string }>; label?: string }>;
  /**
   * Force separation: any of these members, even if the matcher merged them,
   * should get its own canonical id. (Implemented naively: we simply append
   * the raw id into the canonical id to break the tie.)
   */
  unmergeStops: Array<{ feedId: string; rawId: string }>;
  unmergeRoutes: Array<{ feedId: string; rawId: string }>;
}

function emptyOverrides(): RegistryOverrides {
  return {
    version: 1,
    mergeStops: [],
    mergeRoutes: [],
    unmergeStops: [],
    unmergeRoutes: [],
  };
}

// ---- state -----------------------------------------------------------------

let snapshot: RegistrySnapshot | null = null;
let overrides: RegistryOverrides = emptyOverrides();
let booted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeRegistry(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getRegistry(): RegistrySnapshot | null {
  return snapshot;
}

export function getOverrides(): RegistryOverrides {
  return overrides;
}

function memberKey(m: { feedId: string; rawId: string }): string {
  return `${m.feedId}\t${m.rawId}`;
}

// ---- boot / persistence ----------------------------------------------------

export async function rehydrateRegistryOnBoot(): Promise<void> {
  if (booted) return;
  booted = true;
  const [saved, savedOver] = await Promise.all([
    registryStore.getSnapshot<RegistrySnapshot>(),
    registryStore.getOverrides<RegistryOverrides>(),
  ]);
  if (savedOver) overrides = { ...emptyOverrides(), ...savedOver };
  if (saved && saved.version === CURRENT_VERSION) {
    snapshot = saved;
    emit();
  }
}

async function persistSnapshot(): Promise<void> {
  if (!snapshot) return;
  await registryStore.putSnapshot(snapshot).catch((err) => {
    console.warn('registry persist failed', err);
  });
}

async function persistOverrides(): Promise<void> {
  await registryStore.putOverrides(overrides).catch((err) => {
    console.warn('overrides persist failed', err);
  });
}

// ---- build -----------------------------------------------------------------

export interface BuildProgress {
  stage: string;
  feedId?: string;
  step: number;
  total: number;
}

export type ProgressCb = (p: BuildProgress) => void;

/**
 * Rebuild the registry over the currently-loaded feeds.
 * Clears and replaces the in-memory snapshot; persists on success.
 */
export async function buildRegistry(progressCb?: ProgressCb): Promise<RegistrySnapshot> {
  const store = useAppStore.getState();
  const feeds: FeedMeta[] = store.feedOrder.map((id) => store.feeds[id]).filter(Boolean);
  const totalSteps = feeds.length * 2 + 2; // two reads per feed, plus match + persist
  let step = 0;

  const report = (stage: string, feedId?: string) => {
    step += 1;
    progressCb?.({ stage, feedId, step, total: totalSteps });
  };

  const allStops: RawStop[] = [];
  const allRoutes: RawRoute[] = [];
  for (const f of feeds) {
    report('Reading stops', f.id);
    allStops.push(...(await fetchRawStops(f.id)));
    report('Reading routes', f.id);
    allRoutes.push(...(await fetchRawRoutes(f.id)));
  }

  report('Matching stops');
  const stopMatch = matchStops(allStops);
  report('Matching routes');
  const routeMatch = matchRoutes(allRoutes);

  applyStopOverrides(stopMatch, overrides);
  applyRouteOverrides(routeMatch, overrides);

  snapshot = {
    version: CURRENT_VERSION,
    builtAt: Date.now(),
    stopAssignments: mapToRecord(stopMatch.assignments),
    routeAssignments: mapToRecord(routeMatch.assignments),
    stops: mapToObj(stopMatch.canonicals),
    routes: mapToObj(routeMatch.canonicals),
    stopMembers: mapToObj(stopMatch.members),
    routeMembers: mapToObj(routeMatch.members),
    feedIds: feeds.map((f) => f.id),
  };
  emit();
  await persistSnapshot();
  return snapshot;
}

function mapToRecord<V>(m: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}
function mapToObj<V>(m: Map<string, V>): Record<string, V> {
  return mapToRecord(m);
}

// ---- overrides -------------------------------------------------------------

function applyStopOverrides(result: StopMatchResult, ov: RegistryOverrides): void {
  for (const raw of ov.unmergeStops) {
    const key = memberKey(raw);
    const cid = result.assignments.get(key);
    if (!cid) continue;
    const bucket = result.members.get(cid);
    if (!bucket) continue;
    const idx = bucket.findIndex((m) => m.feedId === raw.feedId && m.rawId === raw.rawId);
    if (idx === -1) continue;
    const [removed] = bucket.splice(idx, 1);
    const newCid = `${cid}__split__${raw.feedId}_${raw.rawId}`;
    result.assignments.set(key, newCid);
    result.members.set(newCid, [removed]);
    const srcCanon = result.canonicals.get(cid);
    if (srcCanon) {
      result.canonicals.set(newCid, {
        ...srcCanon,
        canonicalId: newCid,
        lat: removed.lat,
        lon: removed.lon,
        memberCount: 1,
        feedCount: 1,
      });
      srcCanon.memberCount = bucket.length;
      srcCanon.feedCount = new Set(bucket.map((b) => b.feedId)).size;
    }
  }
  for (const merge of ov.mergeStops) {
    if (merge.members.length < 2) continue;
    // Move every listed member under the canonical of the first one.
    const targetKey = memberKey(merge.members[0]);
    const targetCid = result.assignments.get(targetKey);
    if (!targetCid) continue;
    for (let i = 1; i < merge.members.length; i++) {
      const m = merge.members[i];
      const k = memberKey(m);
      const srcCid = result.assignments.get(k);
      if (!srcCid || srcCid === targetCid) continue;
      const srcBucket = result.members.get(srcCid);
      if (srcBucket) {
        const idx = srcBucket.findIndex((x) => x.feedId === m.feedId && x.rawId === m.rawId);
        if (idx !== -1) {
          const [moved] = srcBucket.splice(idx, 1);
          const tgtBucket = result.members.get(targetCid);
          tgtBucket?.push(moved);
        }
        if (srcBucket.length === 0) {
          result.members.delete(srcCid);
          result.canonicals.delete(srcCid);
        }
      }
      result.assignments.set(k, targetCid);
    }
    const tgtBucket = result.members.get(targetCid);
    const tgtCanon = result.canonicals.get(targetCid);
    if (tgtBucket && tgtCanon) {
      tgtCanon.memberCount = tgtBucket.length;
      tgtCanon.feedCount = new Set(tgtBucket.map((b) => b.feedId)).size;
      if (merge.label) tgtCanon.name = merge.label;
    }
  }
}

function applyRouteOverrides(result: RouteMatchResult, ov: RegistryOverrides): void {
  for (const raw of ov.unmergeRoutes) {
    const key = memberKey(raw);
    const cid = result.assignments.get(key);
    if (!cid) continue;
    const bucket = result.members.get(cid);
    if (!bucket) continue;
    const idx = bucket.findIndex((m) => m.feedId === raw.feedId && m.rawId === raw.rawId);
    if (idx === -1) continue;
    const [removed] = bucket.splice(idx, 1);
    const newCid = `${cid}__split__${raw.feedId}_${raw.rawId}`;
    result.assignments.set(key, newCid);
    result.members.set(newCid, [removed]);
    const src = result.canonicals.get(cid);
    if (src) {
      result.canonicals.set(newCid, {
        ...src,
        canonicalId: newCid,
        memberCount: 1,
        feedCount: 1,
      });
      src.memberCount = bucket.length;
      src.feedCount = new Set(bucket.map((b) => b.feedId)).size;
    }
  }
  for (const merge of ov.mergeRoutes) {
    if (merge.members.length < 2) continue;
    const targetCid = result.assignments.get(memberKey(merge.members[0]));
    if (!targetCid) continue;
    for (let i = 1; i < merge.members.length; i++) {
      const m = merge.members[i];
      const k = memberKey(m);
      const srcCid = result.assignments.get(k);
      if (!srcCid || srcCid === targetCid) continue;
      const srcBucket = result.members.get(srcCid);
      if (srcBucket) {
        const idx = srcBucket.findIndex((x) => x.feedId === m.feedId && x.rawId === m.rawId);
        if (idx !== -1) {
          const [moved] = srcBucket.splice(idx, 1);
          result.members.get(targetCid)?.push(moved);
        }
        if (srcBucket.length === 0) {
          result.members.delete(srcCid);
          result.canonicals.delete(srcCid);
        }
      }
      result.assignments.set(k, targetCid);
    }
    const tgtBucket = result.members.get(targetCid);
    const tgtCanon = result.canonicals.get(targetCid);
    if (tgtBucket && tgtCanon) {
      tgtCanon.memberCount = tgtBucket.length;
      tgtCanon.feedCount = new Set(tgtBucket.map((b) => b.feedId)).size;
    }
  }
}

export async function updateOverrides(mut: (ov: RegistryOverrides) => void): Promise<void> {
  mut(overrides);
  await persistOverrides();
}

// ---- lookup helpers --------------------------------------------------------

export function lookupStop(
  feedId: string,
  rawId: string,
  snap: RegistrySnapshot | null = snapshot,
): { canonicalId: string; canonical: CanonicalStop } | null {
  if (!snap) return null;
  const cid = snap.stopAssignments[`${feedId}\t${rawId}`];
  if (!cid) return null;
  const canonical = snap.stops[cid];
  if (!canonical) return null;
  return { canonicalId: cid, canonical };
}

export function lookupRoute(
  feedId: string,
  rawId: string,
  snap: RegistrySnapshot | null = snapshot,
): { canonicalId: string; canonical: CanonicalRoute } | null {
  if (!snap) return null;
  const cid = snap.routeAssignments[`${feedId}\t${rawId}`];
  if (!cid) return null;
  const canonical = snap.routes[cid];
  if (!canonical) return null;
  return { canonicalId: cid, canonical };
}

/** Is the current snapshot built from exactly the currently-loaded feed set? */
export function isRegistryStale(loadedFeedIds: string[]): boolean {
  if (!snapshot) return loadedFeedIds.length > 0;
  const built = new Set(snapshot.feedIds);
  const cur = new Set(loadedFeedIds);
  if (built.size !== cur.size) return true;
  for (const f of built) if (!cur.has(f)) return true;
  return false;
}
