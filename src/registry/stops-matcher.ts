// Stop matcher for the Entity Registry.
//
// Input: a flat list of (feedId, rawStopId, name, lat, lon) from all loaded feeds.
// Output: an assignment of a canonical stop id to each input row, plus a
//         summary record per canonical cluster (representative name + centroid).
//
// Algorithm (scope + identity, two UFs):
//
//   1. Spatial scope (DBSCAN-lite) with eps ≈ `epsMeters` (default 25m).
//      We use a lat/lon grid of ~50m cells plus a 3×3 neighbour scan, so the
//      cost is O(N) in practice even on VOR-scale (~70k stops). This pass
//      only defines the scope inside which identity signals may apply —
//      spatial proximity alone never merges two stops.
//
//   2. Identity signals, fed into a *fresh* UF.
//      (a) Inside the same spatial cluster (≤ eps), union stops that share
//          the same normalized stop name. Empty normalized names still
//          merge — unnamed stops at a platform cluster collapse as before.
//      (b) Globally, union stops that share the same raw `stop_id` across
//          *different* feeds and sit within a wider tolerance
//          (`RAWID_MATCH_M` ≈ 200 m). This catches stable IFOPT-style ids
//          (Austrian "at:42:3654:0:15"…) which are kept across releases
//          even when the display name was tweaked or coordinates drifted.
//          Without signal (b), a trivial name change (e.g. dropping the
//          platform suffix "E1") splits the same physical stop into two
//          canonicals and the diff falsely reports it as removed+added.
//          The 200 m tolerance is wide enough to absorb re-surveyed
//          coordinates and tight enough that two unrelated agencies reusing
//          the same short id cannot accidentally merge.
//
//   3. Collect connected components; each one is a canonical stop. The
//      canonical's `nameKey` is the most common normalized name among its
//      members (ties broken by the longest display name). Two different
//      services at the same platform cluster with genuinely different names
//      and ids (e.g. "Wien Hbf" vs "Wien Hbf Kärntner Str.") still stay
//      separate. A manual-merge override pass can still join them later.

import { normalizeStopName } from './normalize';

export interface RawStop {
  feedId: string;
  rawId: string;
  name: string;
  lat: number;
  lon: number;
}

export interface CanonicalStop {
  canonicalId: string;
  /** Representative display name (longest non-empty raw name wins). */
  name: string;
  /** Normalized name key. */
  nameKey: string;
  /** Cluster centroid in WGS84. */
  lat: number;
  lon: number;
  /** Number of distinct (feedId, rawId) members. */
  memberCount: number;
  /** Distinct feeds this canonical is present in. */
  feedCount: number;
}

export interface StopMatchResult {
  /** `${feedId}\t${rawId}` -> canonical id. */
  assignments: Map<string, string>;
  /** canonical id -> summary. */
  canonicals: Map<string, CanonicalStop>;
  /** canonical id -> full member list (kept for registry persistence + UI drill-in). */
  members: Map<string, RawStop[]>;
}

export interface StopMatcherOptions {
  /** DBSCAN eps in metres. */
  epsMeters?: number;
  /** Only require name-match when name is non-empty on both sides (missing names still co-merge spatially). */
  nameLooseEmpty?: boolean;
}

const DEFAULT_EPS_M = 25;
/**
 * Spatial tolerance for the cross-feed raw stop_id identity signal. Wider
 * than the primary DBSCAN eps because coordinates frequently drift a few
 * tens of metres between releases even when the agency intends the same
 * physical stop. Tight enough to reject wildly-relocated stops.
 */
const RAWID_MATCH_M = 200;
const EARTH_R = 6_371_000;

function memberKey(s: RawStop): string {
  return `${s.feedId}\t${s.rawId}`;
}

/** Haversine distance in metres. */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** Tiny disjoint-set over contiguous integer ids. */
class UF {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    let cur = x;
    while (this.parent[cur] !== r) {
      const nx = this.parent[cur];
      this.parent[cur] = r;
      cur = nx;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Build a spatial grid. Cell size is chosen so that `eps` always fits inside a
 * 3×3 window of cells, i.e. cell_side ≥ eps. We use cell_side = 2*eps in metres
 * converted to degrees — plenty of headroom.
 */
function buildGrid(stops: RawStop[], cellMeters: number): Map<string, number[]> {
  // crude metres-per-degree approximations (longitude varies with latitude).
  // We pick a representative cos(lat) from the dataset to keep cells roughly square.
  const meanLat = stops.reduce((a, s) => a + s.lat, 0) / Math.max(1, stops.length);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  const dLat = cellMeters / mPerDegLat;
  const dLon = cellMeters / Math.max(1, mPerDegLon);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const gy = Math.floor(s.lat / dLat);
    const gx = Math.floor(s.lon / dLon);
    const key = `${gx},${gy}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }
  (grid as Map<string, number[]> & { __dLat?: number; __dLon?: number }).__dLat = dLat;
  (grid as Map<string, number[]> & { __dLat?: number; __dLon?: number }).__dLon = dLon;
  return grid;
}

function canonicalIdForCluster(lat: number, lon: number, nameKey: string): string {
  const lat6 = Math.round(lat * 1e6);
  const lon6 = Math.round(lon * 1e6);
  const latSign = lat6 < 0 ? 'S' : 'N';
  const lonSign = lon6 < 0 ? 'W' : 'E';
  const nameSlug = nameKey.slice(0, 24).replace(/\s+/g, '-') || 'unnamed';
  return `s_${latSign}${Math.abs(lat6)}_${lonSign}${Math.abs(lon6)}_${nameSlug}`;
}

export function matchStops(
  stops: RawStop[],
  opts: StopMatcherOptions = {},
): StopMatchResult {
  const eps = opts.epsMeters ?? DEFAULT_EPS_M;
  const cellM = eps * 2;
  const grid = buildGrid(stops, cellM);
  const uf = new UF(stops.length);

  // Pass 1: union by spatial proximity using a 3×3 cell window.
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos((s.lat * Math.PI) / 180);
    const dLat = cellM / mPerDegLat;
    const dLon = cellM / Math.max(1, mPerDegLon);
    const gy = Math.floor(s.lat / dLat);
    const gx = Math.floor(s.lon / dLon);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const neighbors = grid.get(`${gx + ox},${gy + oy}`);
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue;
          const t = stops[j];
          if (haversine(s.lat, s.lon, t.lat, t.lon) <= eps) uf.union(i, j);
        }
      }
    }
  }

  // Pass 2: split each spatial cluster into canonicals. A second, *empty*
  // UF is used here so spatial proximity alone doesn't merge — it only
  // defines the scope inside which the two identity signals apply.
  // Precompute normalized name keys once.
  const nameKeys = new Array<string>(stops.length);
  for (let i = 0; i < stops.length; i++) nameKeys[i] = normalizeStopName(stops[i].name);

  const bySpatialRoot = new Map<number, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const root = uf.find(i);
    let arr = bySpatialRoot.get(root);
    if (!arr) { arr = []; bySpatialRoot.set(root, arr); }
    arr.push(i);
  }

  const mergeUf = new UF(stops.length);
  for (const idxs of bySpatialRoot.values()) {
    // (a) Inside a spatial cluster, union stops that share a normalized
    //     name. Empty nameKeys fall into the same bucket and merge —
    //     preserves the original behaviour that all unnamed stops at a
    //     common platform cluster collapse to one canonical.
    const firstByName = new Map<string, number>();
    for (const i of idxs) {
      const k = nameKeys[i];
      const first = firstByName.get(k);
      if (first === undefined) firstByName.set(k, i);
      else mergeUf.union(first, i);
    }
  }

  // (b) Cross-feed raw stop_id identity, applied with a *wider* spatial
  //     tolerance than signal (a). This catches stable IFOPT-style ids
  //     (Austrian "at:42:…") where the display name was tweaked and/or
  //     the coordinate drifted by a few tens of metres between releases
  //     — both of which defeat signal (a)'s strict intra-cluster scope.
  //     The tolerance is loose enough to tolerate re-surveyed coordinates
  //     and tight enough that two unrelated agencies that happen to reuse
  //     the same short id cannot accidentally merge (agencies with
  //     colliding ids at the same stop would already be a data bug).
  const crossFeedRawIdGroups = new Map<string, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const k = stops[i].rawId;
    let arr = crossFeedRawIdGroups.get(k);
    if (!arr) { arr = []; crossFeedRawIdGroups.set(k, arr); }
    arr.push(i);
  }
  for (const group of crossFeedRawIdGroups.values()) {
    if (group.length < 2) continue;
    // Skip pure intra-feed groups — rawIds are unique per feed by spec
    // and we'd only be creating no-op unions.
    let multiFeed = false;
    const firstFeed = stops[group[0]].feedId;
    for (let i = 1; i < group.length; i++) {
      if (stops[group[i]].feedId !== firstFeed) { multiFeed = true; break; }
    }
    if (!multiFeed) continue;
    // O(k²) in the group size, but groups are tiny (≈ one entry per feed
    // that contains the id, so typically ≤ number of loaded feeds).
    for (let i = 0; i < group.length; i++) {
      const a = stops[group[i]];
      for (let j = i + 1; j < group.length; j++) {
        const b = stops[group[j]];
        if (a.feedId === b.feedId) continue;
        if (haversine(a.lat, a.lon, b.lat, b.lon) <= RAWID_MATCH_M) {
          mergeUf.union(group[i], group[j]);
        }
      }
    }
  }

  // Pass 3: materialise one canonical per connected component.
  const components = new Map<number, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const root = mergeUf.find(i);
    let arr = components.get(root);
    if (!arr) { arr = []; components.set(root, arr); }
    arr.push(i);
  }

  const assignments = new Map<string, string>();
  const canonicals = new Map<string, CanonicalStop>();
  const members = new Map<string, RawStop[]>();

  for (const idxs of components.values()) {
    let latSum = 0, lonSum = 0;
    let bestDisplay = '';
    const feedSet = new Set<string>();
    // Pick the representative nameKey: most frequent among members, with
    // ties broken by the longest raw display name (more-specific wins).
    const nameStats = new Map<string, { count: number; longestDisplayLen: number }>();
    for (const i of idxs) {
      const s = stops[i];
      latSum += s.lat; lonSum += s.lon;
      if (s.name && s.name.length > bestDisplay.length) bestDisplay = s.name;
      feedSet.add(s.feedId);
      const key = nameKeys[i];
      let stat = nameStats.get(key);
      if (!stat) { stat = { count: 0, longestDisplayLen: 0 }; nameStats.set(key, stat); }
      stat.count += 1;
      const rawLen = s.name ? s.name.length : 0;
      if (rawLen > stat.longestDisplayLen) stat.longestDisplayLen = rawLen;
    }
    let repKey = '';
    let bestCount = -1;
    let bestLen = -1;
    for (const [k, stat] of nameStats) {
      // Prefer non-empty keys so an unnamed minority can't win by count alone.
      const ksc = stat.count + (k ? 0 : -0.5);
      if (
        ksc > bestCount ||
        (ksc === bestCount && stat.longestDisplayLen > bestLen)
      ) {
        bestCount = ksc;
        bestLen = stat.longestDisplayLen;
        repKey = k;
      }
    }

    const lat = latSum / idxs.length;
    const lon = lonSum / idxs.length;
    const cid = canonicalIdForCluster(lat, lon, repKey);
    const memberList: RawStop[] = idxs.map((i) => stops[i]);
    canonicals.set(cid, {
      canonicalId: cid,
      name: bestDisplay || '(unnamed)',
      nameKey: repKey,
      lat,
      lon,
      memberCount: memberList.length,
      feedCount: feedSet.size,
    });
    members.set(cid, memberList);
    for (const m of memberList) assignments.set(memberKey(m), cid);
  }

  return { assignments, canonicals, members };
}

export function lookupStopCanonical(
  result: StopMatchResult,
  feedId: string,
  rawId: string,
): string | null {
  return result.assignments.get(`${feedId}\t${rawId}`) ?? null;
}
