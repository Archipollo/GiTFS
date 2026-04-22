// Shared lookups + React hooks that back the stop/route inspector panels.
//
// The lookups wrap the DuckDB-backed queries in `gtfs/queries` with a small
// in-memory async cache so repeated selections (the user click-walking
// through a station's lines, or scrubbing the timeline) don't re-issue the
// same query. Cached results are keyed by `(feedId, rawId)` and invalidated
// only when a feed is removed — the underlying tables are immutable for a
// given feed id.

import { useEffect, useState } from 'react';
import {
  fetchLinesForStop,
  fetchRouteDirections,
  resolveShapeToRoutes,
  type LineForStop,
  type RouteDirection,
} from '../gtfs/queries';

type Async<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

function keyOf(feedId: string, id: string): string {
  return `${feedId}\t${id}`;
}

// ---- lines-for-stop --------------------------------------------------------

const linesCache = new Map<string, Promise<LineForStop[]>>();

export function getLinesForStop(feedId: string, stopId: string): Promise<LineForStop[]> {
  const k = keyOf(feedId, stopId);
  const hit = linesCache.get(k);
  if (hit) return hit;
  const p = fetchLinesForStop(feedId, stopId).catch((err) => {
    linesCache.delete(k);
    throw err;
  });
  linesCache.set(k, p);
  return p;
}

export function useLinesForStop(
  feedId: string | null | undefined,
  stopId: string | null | undefined,
): Async<LineForStop[]> {
  const [state, setState] = useState<Async<LineForStop[]>>(() =>
    feedId && stopId ? { status: 'loading' } : { status: 'ready', value: [] },
  );
  useEffect(() => {
    if (!feedId || !stopId) {
      setState({ status: 'ready', value: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    getLinesForStop(feedId, stopId)
      .then((value) => {
        if (!cancelled) setState({ status: 'ready', value });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [feedId, stopId]);
  return state;
}

// ---- route directions ------------------------------------------------------
//
// `fetchRouteDirections` returns the representative stop-pattern per
// direction, in real sequence order. This replaces the older
// `fetchStopsForRoute` which returned an alphabetically-sorted, direction-
// less stop set and didn't reflect what riders actually experience.

const routeDirsCache = new Map<string, Promise<RouteDirection[]>>();

export function getRouteDirections(
  feedId: string,
  routeId: string,
): Promise<RouteDirection[]> {
  const k = keyOf(feedId, routeId);
  const hit = routeDirsCache.get(k);
  if (hit) return hit;
  const p = fetchRouteDirections(feedId, routeId).catch((err) => {
    routeDirsCache.delete(k);
    throw err;
  });
  routeDirsCache.set(k, p);
  return p;
}

export function useRouteDirections(
  feedId: string | null | undefined,
  routeId: string | null | undefined,
): Async<RouteDirection[]> {
  const [state, setState] = useState<Async<RouteDirection[]>>(() =>
    feedId && routeId ? { status: 'loading' } : { status: 'ready', value: [] },
  );
  useEffect(() => {
    if (!feedId || !routeId) {
      setState({ status: 'ready', value: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    getRouteDirections(feedId, routeId)
      .then((value) => {
        if (!cancelled) setState({ status: 'ready', value });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [feedId, routeId]);
  return state;
}

// ---- shape → route(s) ------------------------------------------------------

const shapeRouteCache = new Map<string, Promise<string[]>>();

export function getRoutesForShape(feedId: string, shapeId: string): Promise<string[]> {
  const k = keyOf(feedId, shapeId);
  const hit = shapeRouteCache.get(k);
  if (hit) return hit;
  const p = resolveShapeToRoutes(feedId, shapeId).catch((err) => {
    shapeRouteCache.delete(k);
    throw err;
  });
  shapeRouteCache.set(k, p);
  return p;
}
