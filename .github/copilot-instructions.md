# Project review guidelines for GiTFS

## Stack
- React 18 + TypeScript (strict), Vite, Zustand for state.
- Web Workers for heavy GTFS diff / segment graph computation.

## Conventions
- Use named exports only.
- No `any` — prefer `unknown` + narrowing or proper generics.
- Keep heavy work (GTFS parsing, diffing, graph building) inside workers in `src/gtfs/*`. Flag any heavy sync work added to the main thread.
- UI components live under `src/app-shell/`, `src/diff/`, `src/map/`. Don't import worker internals directly into components — go through the store in `src/state/app-store.ts`.

## What to flag
- Mutations of Zustand state outside store actions.
- Missing memoization on expensive derived data passed to MapView.
- Unbounded `useEffect` dependencies that could re-trigger worker postMessage.
- Missing transferables (`postMessage(..., [buffer])`) for large `ArrayBuffer` payloads.

## Don't suggest
- Switching state libraries.
- Adding default exports.