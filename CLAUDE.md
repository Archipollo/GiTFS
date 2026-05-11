# GiTFS — agent context

Git-like **diff**, **timeline**, and **scenario** workflows for **GTFS** transit feeds in the browser (thesis project: longitudinal analysis of Austrian regional networks). No backend required; feeds are unpacked, queried, and persisted client-side.

For user-facing setup and roadmap, see [`README.md`](./README.md) and [`PLAN.md`](./PLAN.md).

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — `tsc -b` then production bundle
- `npm run typecheck` — `tsc -b --noEmit`
- `npm run deploy` — build + `wrangler deploy` (Worker is thin; app is static + browser logic)

## Stack

- React 18, TypeScript (strict), Vite, Zustand
- MapLibre GL, DuckDB-WASM, zip.js (`@zip.js/zip.js`)
- **Web Workers** in `src/gtfs/*` for heavy GTFS work (e.g. diff / segment graph) — keep CPU-heavy paths off the main thread

## `src/` layout

| Area | Role |
|------|------|
| `app-shell/` | Layout: top bar, panels, drawer, upload |
| `map/` | MapLibre view and layer/update wiring |
| `gtfs/` | Ingest, DuckDB, OPFS, diff worker, queries |
| `diff/` | Diff UI and services built on worker/engine |
| `timeline/` | Timeline mode UI and date/math helpers |
| `inspector/` | Stop/route cards and inspector data |
| `registry/` | Registry feature (matching, queries, evaluation) |
| `state/` | Zustand store — **single entry** for cross-cutting app state |

## Conventions

- **Named exports only** — no default exports.
- **No `any`** — use `unknown` + narrowing or proper generics.
- **Do not import worker internals from React components** — go through `src/state/app-store.ts` (and existing hooks/services).
- Prefer **transferables** (`postMessage(..., [buffer])`) when moving large `ArrayBuffer` payloads to/from workers.

## Watch during review

- Zustand state mutated outside store actions.
- Expensive derived data passed into MapView without memoization.
- `useEffect` dependency lists that could spam worker `postMessage`.
- Main-thread GTFS parsing, diffing, or graph builds that belong in `src/gtfs/*` workers.

## Do not propose

- Replacing Zustand with another state library.
- Introducing default exports for consistency with the codebase.
