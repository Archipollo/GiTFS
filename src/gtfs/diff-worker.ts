// Web Worker — runs the route-scoped buffer-overlay diff off the main
// thread.
//
// Receives serialised ShapePolyline arrays for two feeds, plus the
// route-identity correspondence (`RoutePair[]`, already computed by the
// registry-driven entity diff) and each feed's shape->route_id[]
// membership. Builds route-scoped segment indexes, runs the arc-length
// walk + binary-search crossing classification per matched route pair,
// and posts back the classified DiffedRun array. No DuckDB or browser DOM
// APIs are used.

import { diffShapesByRoute, type RoutePair } from './segment-core';
import type { ShapePolyline } from './queries';
import type { DiffedRun } from './segment-core';

interface DiffRequest {
  id: number;
  feedA: string;
  feedB: string;
  shapesA: ShapePolyline[];
  shapesB: ShapePolyline[];
  // Map isn't directly structured-cloneable in a type-safe way across the
  // worker boundary — sent as entries arrays, reconstructed on receipt.
  shapeRouteMapA: [string, string[]][];
  shapeRouteMapB: [string, string[]][];
  pairs: RoutePair[];
}

interface DiffResponse {
  id: number;
  feedA: string;
  feedB: string;
  runs: DiffedRun[];
}

// Minimal worker-scope shim so this file typechecks without pulling
// in the full `WebWorker` lib in tsconfig.app.json.
interface WorkerScope {
  onmessage: ((e: MessageEvent<DiffRequest>) => void) | null;
  postMessage: (msg: DiffResponse) => void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e: MessageEvent<DiffRequest>) => {
  const { id, feedA, feedB, shapesA, shapesB, shapeRouteMapA, shapeRouteMapB, pairs } = e.data;
  const t0 = performance.now();
  const result = diffShapesByRoute(
    feedA, feedB,
    shapesA, shapesB,
    new Map(shapeRouteMapA), new Map(shapeRouteMapB),
    pairs,
  );
  const tDone = performance.now();
  console.info('[diff-worker]', {
    feedA, feedB,
    shapesA: shapesA.length, shapesB: shapesB.length,
    pairs: pairs.length,
    runs: result.runs.length,
    diffMs: Math.round(tDone - t0),
  });
  ctx.postMessage({ id, feedA, feedB, runs: result.runs });
};
