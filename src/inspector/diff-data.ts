// Diff-mode data plumbing for the inspector panels.
//
// "What lines served this canonical stop?" and "What stops did this canonical
// route call at?" both require:
//
//   1. Expanding the canonical → its raw members on feeds A and B (via the
//      registry snapshot),
//   2. Querying DuckDB per raw id (cached by `./data.ts`),
//   3. Canonicalising the results back into registry ids so A- and B-side
//      entries can be merged into one list,
//   4. Annotating each row with its matching diff status.
//
// The returned lists are sorted with a stable order that mirrors what the
// inspector already does in timeline mode: mode priority then short-name.

import { useEffect, useMemo, useState } from 'react';
import { useRegistry } from '../registry/useRegistry';
import { getLinesForStop, getRouteDirections } from './data';
import type { LineForStop, RouteDirection } from '../gtfs/queries';
import type { DiffResult, RouteDiffEntry, StopDiffEntry } from '../diff/engine';
import type { Mode } from '../gtfs/modes';

export interface DiffLineRow {
  /** Canonical route id if known (registry-resolved); else `__raw__<feedId>_<rawId>`. */
  canonicalId: string;
  shortName: string;
  longName: string;
  agency: string;
  mode: Mode;
  aRawId: string | null;
  bRawId: string | null;
  aTripCount: number;
  bTripCount: number;
  /** Diff status if a matching RouteDiffEntry exists, else null. */
  status: string | null;
}

export interface DiffStopRow {
  /** 1-based position within the direction's representative pattern. */
  seq: number;
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  canonicalId: string | null;
  /** Diff status for the stop itself (added/removed/moved/renamed/…). */
  status: string | null;
  /**
   * "match" — appears in both A's and B's version of this direction.
   * "only-here" — in this side's direction only.
   */
  directionRole: 'match' | 'only-here';
}

export interface DiffRouteDirection {
  /** 0, 1, or null (shared by both sides when both provide direction_id). */
  direction_id: number | null;
  headsignA: string;
  headsignB: string;
  tripCountA: number;
  tripCountB: number;
  aStops: DiffStopRow[];
  bStops: DiffStopRow[];
}

// ---- shared ----------------------------------------------------------------

const MODE_RANK: Record<Mode, number> = { rail: 0, metro: 1, tram: 2, bus: 3, other: 4 };

function byModeThenShort(a: { mode: Mode; shortName: string; longName: string }, b: typeof a) {
  const dm = MODE_RANK[a.mode] - MODE_RANK[b.mode];
  if (dm !== 0) return dm;
  const as = a.shortName || a.longName;
  const bs = b.shortName || b.longName;
  return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Build a lookup from every underlying canonical route id (including the
 * fromCid and toCid of renumbered entries) to the matching RouteDiffEntry.
 * This lets us translate "canonical route I found by lookup" into "the
 * user-facing diff entry that covers it".
 */
export function buildRouteCanonicalIndex(
  diff: DiffResult,
): Map<string, RouteDiffEntry> {
  const out = new Map<string, RouteDiffEntry>();
  for (const e of diff.routes) {
    if (e.renumbering) {
      out.set(e.renumbering.fromCanonicalId, e);
      out.set(e.renumbering.toCanonicalId, e);
    } else {
      out.set(e.canonicalId, e);
    }
  }
  return out;
}

export function buildStopCanonicalIndex(
  diff: DiffResult,
): Map<string, StopDiffEntry> {
  const out = new Map<string, StopDiffEntry>();
  for (const e of diff.stops) out.set(e.canonicalId, e);
  return out;
}

// ---- lines for a canonical stop -------------------------------------------

/**
 * Collect and merge lines-for-stop across feeds A and B for a given
 * canonical stop. Each resulting row is annotated with the matching diff
 * status when known.
 */
export function useDiffLinesForStop(
  canonicalStopId: string | null,
  feedA: string | null,
  feedB: string | null,
  diff: DiffResult | null,
): { status: 'loading' | 'ready' | 'error'; value: DiffLineRow[]; message?: string } {
  const registry = useRegistry();
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; value: DiffLineRow[]; message?: string }>(
    { status: 'ready', value: [] },
  );

  useEffect(() => {
    if (!canonicalStopId || !feedA || !feedB || !registry || !diff) {
      setState({ status: 'ready', value: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', value: [] });
    (async () => {
      try {
        const members = registry.stopMembers[canonicalStopId] ?? [];
        const rawsA = members.filter((m) => m.feedId === feedA).map((m) => m.rawId);
        const rawsB = members.filter((m) => m.feedId === feedB).map((m) => m.rawId);

        const [aLineSets, bLineSets] = await Promise.all([
          Promise.all(rawsA.map((id) => getLinesForStop(feedA, id))),
          Promise.all(rawsB.map((id) => getLinesForStop(feedB, id))),
        ]);
        if (cancelled) return;

        const routeIdx = buildRouteCanonicalIndex(diff);

        // Union per canonical route id (fallback to raw id if unknown).
        const rows = new Map<string, DiffLineRow>();

        const absorbSide = (
          feedId: string,
          sets: LineForStop[][],
          side: 'a' | 'b',
        ) => {
          for (const list of sets) {
            for (const l of list) {
              const cidFromReg = registry.routeAssignments[`${feedId}\t${l.route_id}`];
              const diffEntry = cidFromReg ? routeIdx.get(cidFromReg) : undefined;
              const key = diffEntry
                ? diffEntry.canonicalId
                : cidFromReg ?? `__raw__${feedId}_${l.route_id}`;
              let row = rows.get(key);
              if (!row) {
                row = {
                  canonicalId: key,
                  shortName: l.route_short_name,
                  longName: l.route_long_name,
                  agency: l.agency_name,
                  mode: l.mode,
                  aRawId: null,
                  bRawId: null,
                  aTripCount: 0,
                  bTripCount: 0,
                  status: diffEntry?.status ?? null,
                };
                rows.set(key, row);
              } else {
                // Prefer longer display strings; they're usually more informative.
                if (l.route_short_name.length > row.shortName.length) row.shortName = l.route_short_name;
                if (l.route_long_name.length > row.longName.length) row.longName = l.route_long_name;
                if (l.agency_name.length > row.agency.length) row.agency = l.agency_name;
              }
              if (side === 'a') {
                row.aRawId = l.route_id;
                row.aTripCount += l.trip_count;
              } else {
                row.bRawId = l.route_id;
                row.bTripCount += l.trip_count;
              }
            }
          }
        };

        absorbSide(feedA, aLineSets, 'a');
        absorbSide(feedB, bLineSets, 'b');

        const out = [...rows.values()].sort(byModeThenShort);
        setState({ status: 'ready', value: out });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          value: [],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canonicalStopId, feedA, feedB, registry, diff]);

  return state;
}

// ---- stops for a canonical route, by direction ----------------------------

/**
 * Resolve paired, direction-grouped stop patterns for a canonical route
 * across feeds A and B.
 *
 * For each `direction_id` we look up the representative (longest-pattern)
 * trip on both sides and build two ordered stop lists that the inspector can
 * render as side-by-side columns. Each stop row is annotated with:
 *   - the stop's diff status from the registry (added/removed/moved/…), and
 *   - whether the stop's canonical id also appears in the other side's
 *     pattern for this same direction (so added/removed-from-line can be
 *     rendered even when the stop itself is "unchanged").
 *
 * Directions are paired by `direction_id` when present; if either side is
 * missing a direction, its list is empty for that course.
 */
export function useDiffStopsForRoute(
  canonicalRouteId: string | null,
  feedA: string | null,
  feedB: string | null,
  diff: DiffResult | null,
): {
  status: 'loading' | 'ready' | 'error';
  directions: DiffRouteDirection[];
  message?: string;
} {
  const registry = useRegistry();
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    directions: DiffRouteDirection[];
    message?: string;
  }>({ status: 'ready', directions: [] });

  // Resolve renumbered synthetic ids into their (fromCid, toCid) pair;
  // otherwise the canonical id is used unchanged on both sides.
  const { fromCid, toCid } = useMemo(() => {
    if (!canonicalRouteId) return { fromCid: null, toCid: null };
    if (canonicalRouteId.startsWith('ren__')) {
      const rest = canonicalRouteId.slice(5);
      const mid = rest.indexOf('__');
      if (mid < 0) return { fromCid: null, toCid: canonicalRouteId };
      return { fromCid: rest.slice(0, mid), toCid: rest.slice(mid + 2) };
    }
    return { fromCid: canonicalRouteId, toCid: canonicalRouteId };
  }, [canonicalRouteId]);

  useEffect(() => {
    if (!canonicalRouteId || !feedA || !feedB || !registry || !diff) {
      setState({ status: 'ready', directions: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', directions: [] });
    (async () => {
      try {
        const aMembers = fromCid
          ? (registry.routeMembers[fromCid] ?? []).filter((m) => m.feedId === feedA)
          : [];
        const bMembers = toCid
          ? (registry.routeMembers[toCid] ?? []).filter((m) => m.feedId === feedB)
          : [];

        const [aDirSets, bDirSets] = await Promise.all([
          Promise.all(aMembers.map((m) => getRouteDirections(feedA, m.rawId))),
          Promise.all(bMembers.map((m) => getRouteDirections(feedB, m.rawId))),
        ]);
        if (cancelled) return;

        const stopIdx = buildStopCanonicalIndex(diff);

        // Fold multiple raw-route members on each side into a single map
        // keyed by direction_id. If two raw members share a direction_id
        // (common when a route was split), we pick the one with the longest
        // pattern — same heuristic as within a single raw route.
        const bestByDir = (sets: RouteDirection[][]): Map<number, RouteDirection> => {
          const out = new Map<number, RouteDirection>();
          for (const list of sets) {
            for (const d of list) {
              const k = d.direction_id ?? -1;
              const prev = out.get(k);
              if (!prev || d.stops.length > prev.stops.length) out.set(k, d);
            }
          }
          return out;
        };
        const aByDir = bestByDir(aDirSets);
        const bByDir = bestByDir(bDirSets);

        // Union of direction ids; keep the stable 0 → 1 → null ordering.
        const dirKeys = [...new Set([...aByDir.keys(), ...bByDir.keys()])].sort((x, y) => {
          if (x === y) return 0;
          if (x === -1) return 1;
          if (y === -1) return -1;
          return x - y;
        });

        const directions: DiffRouteDirection[] = dirKeys.map((k) => {
          const aDir = aByDir.get(k) ?? null;
          const bDir = bByDir.get(k) ?? null;

          // Build canonical-id sets for the other side of this direction so
          // we can tag stops as only-on-this-side vs present-on-both.
          const canonSet = (dir: RouteDirection | null, feedId: string): Set<string> => {
            const out = new Set<string>();
            if (!dir) return out;
            for (const s of dir.stops) {
              const cid = registry.stopAssignments[`${feedId}\t${s.stop_id}`];
              if (cid) out.add(cid);
            }
            return out;
          };
          const aCanonSet = canonSet(aDir, feedA);
          const bCanonSet = canonSet(bDir, feedB);

          const toRow = (
            feedId: string,
            s: RouteDirection['stops'][number],
            i: number,
            otherSideCanon: Set<string>,
          ): DiffStopRow => {
            const cid = registry.stopAssignments[`${feedId}\t${s.stop_id}`] ?? null;
            const regStatus = cid ? stopIdx.get(cid)?.status ?? null : null;
            const inOther = !!cid && otherSideCanon.has(cid);
            return {
              seq: i + 1,
              stopId: s.stop_id,
              stopName: s.stop_name,
              lat: s.lat,
              lon: s.lon,
              canonicalId: cid,
              status: regStatus,
              directionRole: inOther ? 'match' : 'only-here',
            };
          };

          return {
            direction_id: k === -1 ? null : k,
            headsignA: aDir?.headsign ?? '',
            headsignB: bDir?.headsign ?? '',
            tripCountA: aDir?.trip_count ?? 0,
            tripCountB: bDir?.trip_count ?? 0,
            aStops: aDir
              ? aDir.stops.map((s, i) => toRow(feedA, s, i, bCanonSet))
              : [],
            bStops: bDir
              ? bDir.stops.map((s, i) => toRow(feedB, s, i, aCanonSet))
              : [],
          };
        });

        setState({ status: 'ready', directions });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          directions: [],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canonicalRouteId, feedA, feedB, registry, diff, fromCid, toCid]);

  return state;
}

