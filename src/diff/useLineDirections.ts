// Shared headsign lookup for a diffed line's directions.
//
// Given a route diff entry, fetches the per-direction representative trips from
// both feeds (via the cached `getRouteDirections`) and folds them into a single
// `direction_id -> headsign` map. Used by the line-list sidebar (sub-row labels)
// and the route detail header ("dir N -> headsign"). Which direction_ids are
// actually *isolable* on the map comes from `diffRouteDirections` in the store —
// this hook only supplies the human-readable label for each.

import { useEffect, useState } from 'react';
import { getRouteDirections } from '../inspector/data';
import type { RouteDiffEntry } from './engine';

export interface LineDirectionHeadsigns {
  loading: boolean;
  /** direction_id -> best headsign (prefers the new feed's, falls back to old). */
  headsigns: Map<number, string>;
  /**
   * direction_id -> `stop_id`s actually visited by this route+direction's
   * representative trip pattern, kept per feed since a rerouted stop may
   * belong to one side only. Used to tell apart same-named-but-different
   * physical stops (e.g. two stop_ids sharing a name at an intersection)
   * when scoping the stop-diff overlay to a focused line/direction — a
   * proximity-only check can't distinguish them, but the actual stop_id can.
   */
  stopIdsByDirection: Map<number, { a: Set<string>; b: Set<string> }>;
}

const EMPTY: Map<number, string> = new Map();
const EMPTY_STOP_IDS: Map<number, { a: Set<string>; b: Set<string> }> = new Map();

/**
 * @param entry  the focused route's diff entry (`a` = feed A/old, `b` = feed B/new)
 * @param feedA  old feed id (matches `entry.a.rawIds`)
 * @param feedB  new feed id (matches `entry.b.rawIds`)
 * @param enabled skip fetching until the row is actually expanded/focused
 */
export function useLineDirections(
  entry: RouteDiffEntry | null,
  feedA: string | null | undefined,
  feedB: string | null | undefined,
  enabled = true,
): LineDirectionHeadsigns {
  const [state, setState] = useState<LineDirectionHeadsigns>({
    loading: false,
    headsigns: EMPTY,
    stopIdsByDirection: EMPTY_STOP_IDS,
  });

  const aRawIds = entry?.a?.rawIds ?? [];
  const bRawIds = entry?.b?.rawIds ?? [];
  // Stable dependency keys so the effect only re-runs when the actual ids change.
  const aKey = aRawIds.join(',');
  const bKey = bRawIds.join(',');

  useEffect(() => {
    if (!enabled || !entry || (!feedA && !feedB)) {
      setState({ loading: false, headsigns: EMPTY, stopIdsByDirection: EMPTY_STOP_IDS });
      return;
    }
    let cancelled = false;
    setState({ loading: true, headsigns: EMPTY, stopIdsByDirection: EMPTY_STOP_IDS });
    (async () => {
      try {
        const [aSets, bSets] = await Promise.all([
          feedA ? Promise.all(aRawIds.map((id) => getRouteDirections(feedA, id))) : Promise.resolve([]),
          feedB ? Promise.all(bRawIds.map((id) => getRouteDirections(feedB, id))) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const headsigns = new Map<number, string>();
        // Apply the old feed first, then let the new feed override — so a
        // surviving line shows its current headsign, but a removed direction
        // still gets a label from the old feed.
        for (const list of aSets) {
          for (const d of list) {
            if (d.direction_id == null) continue;
            if (d.headsign) headsigns.set(d.direction_id, d.headsign);
          }
        }
        for (const list of bSets) {
          for (const d of list) {
            if (d.direction_id == null) continue;
            if (d.headsign) headsigns.set(d.direction_id, d.headsign);
          }
        }
        const stopIdsByDirection = new Map<number, { a: Set<string>; b: Set<string> }>();
        const bucketFor = (dir: number) => {
          let b = stopIdsByDirection.get(dir);
          if (!b) { b = { a: new Set(), b: new Set() }; stopIdsByDirection.set(dir, b); }
          return b;
        };
        for (const list of aSets) {
          for (const d of list) {
            if (d.direction_id == null) continue;
            const bucket = bucketFor(d.direction_id);
            for (const s of d.stops) bucket.a.add(s.stop_id);
          }
        }
        for (const list of bSets) {
          for (const d of list) {
            if (d.direction_id == null) continue;
            const bucket = bucketFor(d.direction_id);
            for (const s of d.stops) bucket.b.add(s.stop_id);
          }
        }
        setState({ loading: false, headsigns, stopIdsByDirection });
      } catch (err) {
        if (!cancelled) {
          console.warn('line-direction headsign fetch failed', err);
          setState({ loading: false, headsigns: EMPTY, stopIdsByDirection: EMPTY_STOP_IDS });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, feedA, feedB, aKey, bKey]);

  return state;
}
