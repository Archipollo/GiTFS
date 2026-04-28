// Web Worker — runs the buffer-overlay diff off the main thread.
//
// Receives serialised ShapePolyline arrays for two feeds, builds the
// segment indexes locally, runs the arc-length walk + binary-search
// crossing classification, and posts back the classified DiffedRun
// array. No DuckDB or browser DOM APIs are used.

import { buildShapeIndex, diffShapes } from './segment-core';
import type { ShapePolyline } from './queries';
import type { DiffedRun } from './segment-core';

interface DiffRequest {
  id: number;
  feedA: string;
  feedB: string;
  shapesA: ShapePolyline[];
  shapesB: ShapePolyline[];
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
  const { id, feedA, feedB, shapesA, shapesB } = e.data;
  const tBuild = performance.now();
  const idxA = buildShapeIndex(feedA, shapesA);
  const idxB = buildShapeIndex(feedB, shapesB);
  const tDiff = performance.now();
  const result = diffShapes(idxA, idxB);
  const tDone = performance.now();
  console.info('[diff-worker]', {
    feedA, feedB,
    shapesA: shapesA.length, shapesB: shapesB.length,
    segmentsA: idxA.segmentCount, segmentsB: idxB.segmentCount,
    runs: result.runs.length,
    buildMs: Math.round(tDiff - tBuild),
    diffMs: Math.round(tDone - tDiff),
  });
  ctx.postMessage({ id, feedA, feedB, runs: result.runs });
};
