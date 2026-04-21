# GiTFS

**Git-like diff, timeline, and scenario analysis for GTFS public transit feeds.**

A diploma thesis project focused on longitudinal analysis of Austrian regional public transit networks (Vorarlberg, Kärnten, VOR). Browser-first, no backend required.

See [`PLAN.md`](./PLAN.md) for the full roadmap and research framing.

## Three modes

- **Timeline** — load N feeds (e.g. VOR 2020–2026), scrub between them on a map.
- **Diff** — pairwise comparison of two feeds, Git-like added/removed/modified overlays.
- **Scenario** — JSON-patch edits layered on a baseline, auto-diffed against it.

## Stack

- React + TypeScript + Vite
- MapLibre GL JS (OpenStreetMap raster tiles for now)
- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) for CSV-over-SQL against GTFS `.txt` files in-browser
- JSZip for GTFS zip unpacking
- Zustand for UI state
- OPFS for persistent feed storage (raw zips)

## Getting started

```bash
npm install
npm run dev
```

Then open the printed dev URL and click **Load GTFS zip** in the top bar to ingest a feed. Try a small Austrian regional feed first (e.g. Vorarlberg, ~40 MB) to verify everything is wired up. VOR-scale (~1 GB unzipped) will work but takes longer on first ingest.

Recommended sources:
- [data.gv.at](https://www.data.gv.at) — Austrian open data portal
- `mobilitaetsverbuende.at` — harmonised regional feeds

## Project layout

```
src/
  app-shell/     layout components (TopBar, panels, drawer) + layout.css
  map/           MapLibre view + GeoJSON layer management
  gtfs/          duckdb init, ingest pipeline, queries, OPFS persistence
  state/         zustand app store
```

## Current status: M1 skeleton

✓ Vite + React + TS project
✓ App shell with mode tabs, map, panels, bottom drawer
✓ GTFS zip ingest → DuckDB-WASM tables (per-feed, prefixed by feed id)
✓ Stops + shape polylines rendered from the active feed
✓ OPFS persistence stub for raw zip files
✗ Parquet shard build on first ingest (planned)
✗ Re-hydrate feeds from OPFS on boot (planned)
✗ Entity Registry (M2 — thesis core)

## License

TBD (open-source planned after thesis submission).
