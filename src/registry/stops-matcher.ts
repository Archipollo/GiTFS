// Stop matcher for the Entity Registry.
//
// Input: a flat list of (feedId, rawStopId, name, lat, lon) from all loaded feeds.
// Output: an assignment of a canonical stop id to each input row, plus a
//         summary record per canonical cluster (representative name + centroid).
//
// Algorithm (two-stage):
//
//   1. Spatial clustering (DBSCAN-lite) with eps ≈ `epsMeters` (default 25m).
//      We use a lat/lon grid of ~50m cells plus a 3×3 neighbour scan, so the
//      cost is O(N) in practice even on VOR-scale (~70k stops).
//
//   2. Within each spatial cluster, split by normalized stop name. Two stops
//      get the same canonical id iff they land in the same spatial cluster
//      AND their normalized names match exactly.
//
//   This is deliberately conservative: two different services at the same
//   platform cluster with genuinely different names (e.g. "Wien Hbf" vs
//   "Wien Hbf Kärntner Str.") stay separate. A manual-merge override pass
//   can still join them later.

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

  // Pass 2: split each spatial cluster by normalized name.
  // We precompute name keys once.
  const nameKeys = new Array<string>(stops.length);
  for (let i = 0; i < stops.length; i++) nameKeys[i] = normalizeStopName(stops[i].name);

  // bucket[spatialRoot][nameKey] -> member indices
  const buckets = new Map<number, Map<string, number[]>>();
  for (let i = 0; i < stops.length; i++) {
    const root = uf.find(i);
    let byName = buckets.get(root);
    if (!byName) { byName = new Map(); buckets.set(root, byName); }
    const key = nameKeys[i];
    let arr = byName.get(key);
    if (!arr) { arr = []; byName.set(key, arr); }
    arr.push(i);
  }

  const assignments = new Map<string, string>();
  const canonicals = new Map<string, CanonicalStop>();
  const members = new Map<string, RawStop[]>();

  for (const [, byName] of buckets) {
    for (const [nameKey, idxs] of byName) {
      let latSum = 0, lonSum = 0;
      let bestDisplay = '';
      const feedSet = new Set<string>();
      for (const i of idxs) {
        const s = stops[i];
        latSum += s.lat; lonSum += s.lon;
        if (s.name && s.name.length > bestDisplay.length) bestDisplay = s.name;
        feedSet.add(s.feedId);
      }
      const lat = latSum / idxs.length;
      const lon = lonSum / idxs.length;
      const cid = canonicalIdForCluster(lat, lon, nameKey);
      const memberList: RawStop[] = idxs.map((i) => stops[i]);
      canonicals.set(cid, {
        canonicalId: cid,
        name: bestDisplay || '(unnamed)',
        nameKey,
        lat,
        lon,
        memberCount: memberList.length,
        feedCount: feedSet.size,
      });
      members.set(cid, memberList);
      for (const m of memberList) assignments.set(memberKey(m), cid);
    }
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
