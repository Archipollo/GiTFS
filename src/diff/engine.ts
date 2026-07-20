// IR-level diff between two GTFS feeds.
//
// The matching work was already done by the Entity Registry (stops-matcher,
// routes-matcher). This file is a pure reducer: given
//
//   - the shared registry snapshot, and
//   - the per-feed raw rows that contributed to each canonical,
//
// it produces a `DiffResult` with one entry per canonical entity that was
// present in at least one of the two feeds. Every entry is tagged with a
// high-level status and carries the per-side attributes needed by the
// inspector and the map overlay.
//
// Stops follow the categories listed in PLAN.md §5:
//   added / removed / moved / renamed / unchanged
// Routes use:
//   added / removed / renumbered / modified / unchanged
// "Renumbered" is detected in a secondary pass over routes that are present
// on only one side: if a removed route on A and an added route on B share
// (agency, mode, longName), we re-label them as a single renumbered entry.
// `reshaped` is reserved for a future pass over aggregated shapes.
//
// The engine is synchronous and makes no network or DuckDB calls.

import type { RegistrySnapshot } from '../registry/registry';
import type { RawStop, CanonicalStop } from '../registry/stops-matcher';
import type { RawRoute, CanonicalRoute } from '../registry/routes-matcher';
import type { Mode } from '../gtfs/modes';
import { normalizeStopName, normalizeLoose, normalizeRouteShortName } from '../registry/normalize';

// ---- status types ----------------------------------------------------------

export type StopStatus = 'added' | 'removed' | 'moved' | 'renamed' | 'unchanged';
export type RouteStatus = 'added' | 'removed' | 'renumbered' | 'modified' | 'unchanged';

/** Per-feed view of a canonical stop cluster. */
export interface StopSide {
  /** Centroid of the raw members in this feed. */
  lat: number;
  lon: number;
  /** Longest raw name in this feed (fallback to ''). */
  name: string;
  /** Raw `stop_id`s contributing to the canonical from this feed. */
  rawIds: string[];
}

/** Per-feed view of a canonical route. */
export interface RouteSide {
  shortName: string;
  longName: string;
  agencyName: string;
  mode: Mode;
  /** Raw `route_id`s contributing to the canonical from this feed. */
  rawIds: string[];
}

export interface StopDiffEntry {
  canonicalId: string;
  /** Representative canonical (combined across feeds). Convenient for UI. */
  canonical: CanonicalStop;
  status: StopStatus;
  /** Secondary flags: a 'moved' stop may also be renamed, etc. */
  renamed: boolean;
  moved: boolean;
  /** Centroid distance in metres (only meaningful when both sides exist). */
  distM: number;
  a: StopSide | null;
  b: StopSide | null;
}

export interface RouteDiffEntry {
  /**
   * For normal entries: the canonical id of the route on both sides (or the one side).
   * For renumbered entries: synthetic id `ren__<removedCid>__<addedCid>`.
   */
  canonicalId: string;
  canonical: CanonicalRoute;
  status: RouteStatus;
  /** For renumbered entries, carry both canonical ids for drill-in. */
  renumbering?: { fromCanonicalId: string; toCanonicalId: string };
  a: RouteSide | null;
  b: RouteSide | null;
}

export interface DiffSummary {
  stops: Record<StopStatus, number>;
  routes: Record<RouteStatus, number>;
}

export interface DiffResult {
  feedA: string;
  feedB: string;
  builtAt: number;
  stops: StopDiffEntry[];
  routes: RouteDiffEntry[];
  summary: DiffSummary;
}

// ---- options ---------------------------------------------------------------

export interface DiffOptions {
  /** A canonical stop is 'moved' iff the per-feed centroids differ by more than this (metres). */
  movedThresholdMeters?: number;
}

const DEFAULT_MOVED_M = 15;

// ---- helpers ---------------------------------------------------------------

const EARTH_R = 6_371_000;
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function emptyStopSummary(): Record<StopStatus, number> {
  return { added: 0, removed: 0, moved: 0, renamed: 0, unchanged: 0 };
}
function emptyRouteSummary(): Record<RouteStatus, number> {
  return { added: 0, removed: 0, renumbered: 0, modified: 0, unchanged: 0 };
}

function stopSideFromRaws(raws: RawStop[]): StopSide {
  let latSum = 0, lonSum = 0, bestName = '';
  for (const r of raws) {
    latSum += r.lat; lonSum += r.lon;
    if (r.name && r.name.length > bestName.length) bestName = r.name;
  }
  return {
    lat: latSum / raws.length,
    lon: lonSum / raws.length,
    name: bestName,
    rawIds: raws.map((r) => r.rawId),
  };
}

function routeSideFromRaws(raws: RawRoute[], canonical: CanonicalRoute): RouteSide {
  let bestShort = '', bestLong = '', bestAgency = '';
  for (const r of raws) {
    if (r.shortName && r.shortName.length > bestShort.length) bestShort = r.shortName;
    if (r.longName && r.longName.length > bestLong.length) bestLong = r.longName;
    if (r.agencyName && r.agencyName.length > bestAgency.length) bestAgency = r.agencyName;
  }
  return {
    shortName: bestShort,
    longName: bestLong,
    agencyName: bestAgency,
    mode: canonical.mode,
    rawIds: raws.map((r) => r.rawId),
  };
}

// ---- core ------------------------------------------------------------------

export function diffFeeds(
  feedA: string,
  feedB: string,
  registry: RegistrySnapshot,
  rawStopsA: RawStop[],
  rawStopsB: RawStop[],
  rawRoutesA: RawRoute[],
  rawRoutesB: RawRoute[],
  opts: DiffOptions = {},
): DiffResult {
  const movedM = opts.movedThresholdMeters ?? DEFAULT_MOVED_M;

  // Build per-canonical buckets of raw rows for each side.
  const stopsBucketsA = bucketByCanonical(rawStopsA, registry.stopAssignments);
  const stopsBucketsB = bucketByCanonical(rawStopsB, registry.stopAssignments);
  const routesBucketsA = bucketByCanonical(rawRoutesA, registry.routeAssignments);
  const routesBucketsB = bucketByCanonical(rawRoutesB, registry.routeAssignments);

  const stops: StopDiffEntry[] = [];
  const stopSummary = emptyStopSummary();

  const stopCanonicalIds = new Set<string>([...stopsBucketsA.keys(), ...stopsBucketsB.keys()]);
  for (const cid of stopCanonicalIds) {
    const aRaws = stopsBucketsA.get(cid);
    const bRaws = stopsBucketsB.get(cid);
    const canonical = registry.stops[cid];
    if (!canonical) continue; // should not happen, but be defensive

    const a = aRaws ? stopSideFromRaws(aRaws) : null;
    const b = bRaws ? stopSideFromRaws(bRaws) : null;

    let status: StopStatus;
    let distM = 0;
    let renamed = false;
    let moved = false;
    if (a && !b) {
      status = 'removed';
    } else if (!a && b) {
      status = 'added';
    } else if (a && b) {
      distM = haversine(a.lat, a.lon, b.lat, b.lon);
      moved = distM > movedM;
      renamed = normalizeStopName(a.name) !== normalizeStopName(b.name);
      if (moved) status = 'moved';
      else if (renamed) status = 'renamed';
      else status = 'unchanged';
    } else {
      continue; // canonical with no members in either feed (shouldn't happen)
    }

    stops.push({ canonicalId: cid, canonical, status, renamed, moved, distM, a, b });
    stopSummary[status] += 1;
  }

  // ---- routes: base pass -------------------------------------------------
  const routes: RouteDiffEntry[] = [];
  const routeSummary = emptyRouteSummary();
  const routeCanonicalIds = new Set<string>([...routesBucketsA.keys(), ...routesBucketsB.keys()]);
  // Collect add/remove first so the renumbered pass can rescue pairs.
  const rawAdded: RouteDiffEntry[] = [];
  const rawRemoved: RouteDiffEntry[] = [];

  for (const cid of routeCanonicalIds) {
    const aRaws = routesBucketsA.get(cid);
    const bRaws = routesBucketsB.get(cid);
    const canonical = registry.routes[cid];
    if (!canonical) continue;

    const a = aRaws ? routeSideFromRaws(aRaws, canonical) : null;
    const b = bRaws ? routeSideFromRaws(bRaws, canonical) : null;

    if (a && !b) {
      rawRemoved.push({ canonicalId: cid, canonical, status: 'removed', a, b });
    } else if (!a && b) {
      rawAdded.push({ canonicalId: cid, canonical, status: 'added', a, b });
    } else if (a && b) {
      // "modified" = any displayable attribute differs, even though the
      // canonical id matched. In practice that's long_name or agency_name,
      // since short_name + mode are the canonical key.
      const changed =
        normalizeLoose(a.longName) !== normalizeLoose(b.longName) ||
        normalizeLoose(a.agencyName) !== normalizeLoose(b.agencyName);
      const status: RouteStatus = changed ? 'modified' : 'unchanged';
      routes.push({ canonicalId: cid, canonical, status, a, b });
      routeSummary[status] += 1;
    }
  }

  // ---- routes: renumbered pass ------------------------------------------
  // Match each removed route with an added route that shares agency+mode+longName.
  const addedByFingerprint = new Map<string, RouteDiffEntry[]>();
  for (const e of rawAdded) {
    const fp = routeFingerprint(e.b!);
    if (!fp) continue;
    let arr = addedByFingerprint.get(fp);
    if (!arr) { arr = []; addedByFingerprint.set(fp, arr); }
    arr.push(e);
  }

  const consumedAdded = new Set<RouteDiffEntry>();
  for (const rem of rawRemoved) {
    const fp = routeFingerprint(rem.a!);
    const candidates = fp ? addedByFingerprint.get(fp) : undefined;
    const partner = candidates?.find((c) => !consumedAdded.has(c));
    if (partner) {
      consumedAdded.add(partner);
      const syntheticCid = `ren__${rem.canonicalId}__${partner.canonicalId}`;
      routes.push({
        canonicalId: syntheticCid,
        // Prefer the 'to' canonical as the representative so UI labels match current (B) world.
        canonical: partner.canonical,
        status: 'renumbered',
        renumbering: {
          fromCanonicalId: rem.canonicalId,
          toCanonicalId: partner.canonicalId,
        },
        a: rem.a,
        b: partner.b,
      });
      routeSummary.renumbered += 1;
    } else {
      routes.push(rem);
      routeSummary.removed += 1;
    }
  }
  for (const add of rawAdded) {
    if (consumedAdded.has(add)) continue;
    routes.push(add);
    routeSummary.added += 1;
  }

  return {
    feedA,
    feedB,
    builtAt: Date.now(),
    stops,
    routes,
    summary: { stops: stopSummary, routes: routeSummary },
  };
}

/**
 * Per-feed (raw route_id -> RouteStatus) lookup, derived from `result.routes`.
 * Used by the map layer to tell whether the route that owns a piece of
 * drawn geometry was itself removed/added, independent of whether its
 * corridor is still physically covered by another route.
 */
export function buildRouteStatusByRawId(
  result: DiffResult,
): { a: Map<string, RouteStatus>; b: Map<string, RouteStatus> } {
  const a = new Map<string, RouteStatus>();
  const b = new Map<string, RouteStatus>();
  for (const entry of result.routes) {
    if (entry.a) for (const id of entry.a.rawIds) a.set(id, entry.status);
    if (entry.b) for (const id of entry.b.rawIds) b.set(id, entry.status);
  }
  return { a, b };
}

function routeFingerprint(side: RouteSide): string | null {
  const longKey = normalizeLoose(side.longName);
  if (!longKey) return null; // not enough to be confident
  const agency = normalizeLoose(side.agencyName) || '__none__';
  return `${agency}|${side.mode}|${longKey}`;
}

/**
 * Build (canonicalId -> raws[]) for rows coming from a single feed.
 * Ignores rows that have no canonical assignment (e.g. the registry is
 * stale relative to the provided raw data).
 */
function bucketByCanonical<T extends { feedId: string; rawId: string }>(
  raws: T[],
  assignments: Record<string, string>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of raws) {
    const cid = assignments[`${r.feedId}\t${r.rawId}`];
    if (!cid) continue;
    let arr = out.get(cid);
    if (!arr) { arr = []; out.set(cid, arr); }
    arr.push(r);
  }
  return out;
}

// ---- convenience helpers for UI --------------------------------------------

export function stopDiffLabel(e: StopDiffEntry): string {
  if (e.status === 'moved' && e.renamed) return 'moved + renamed';
  return e.status;
}

export function routeDiffLabel(e: RouteDiffEntry): string {
  return e.status;
}

/** Route short-name key used for renumbered detection — exported for tests. */
export function routeShortKey(shortName: string | null | undefined): string {
  return normalizeRouteShortName(shortName ?? null);
}
