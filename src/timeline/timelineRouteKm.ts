// Route-length delta ("kilometres of line added/removed") for the Timeline
// change panel. Reuses the same route shapes the frequency overlay draws —
// no separate geometry pipeline — and reduces each route to the length of
// its single longest shape variant (a reasonable stand-in for "the route's
// length" when branches/loops share a route_id).

import { fetchRouteRepresentativeShapes } from '../gtfs/queries';
import type { DiffResult } from '../diff/engine';

export interface RouteKmDelta {
  addedKm: number;
  removedKm: number;
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(a: [number, number], b: [number, number]): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h =
    s1 * s1 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * s2 * s2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function polylineKm(coords: [number, number][]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += haversineKm(coords[i - 1], coords[i]);
  return km;
}

function longestVariantKm(variants: [number, number][][]): number {
  let max = 0;
  for (const v of variants) max = Math.max(max, polylineKm(v));
  return max;
}

async function sumRouteKm(feedId: string, routeIds: string[]): Promise<number> {
  if (routeIds.length === 0) return 0;
  const shapesByRoute = await fetchRouteRepresentativeShapes(feedId, routeIds);
  let total = 0;
  for (const variants of shapesByRoute.values()) total += longestVariantKm(variants);
  return total;
}

/** Sum of route lengths added minus removed between `diff.feedA` (before) and `diff.feedB` (after). */
export async function computeRouteKmDelta(diff: DiffResult): Promise<RouteKmDelta> {
  const addedRouteIds = diff.routes.filter((r) => r.status === 'added' && r.b).flatMap((r) => r.b!.rawIds);
  const removedRouteIds = diff.routes.filter((r) => r.status === 'removed' && r.a).flatMap((r) => r.a!.rawIds);

  const [addedKm, removedKm] = await Promise.all([
    sumRouteKm(diff.feedB, addedRouteIds),
    sumRouteKm(diff.feedA, removedRouteIds),
  ]);

  return { addedKm, removedKm };
}
