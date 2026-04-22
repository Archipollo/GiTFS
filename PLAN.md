# GiTFS — Plan

GiTFS (Git + GTFS) is a browser-first web tool for analyzing Austrian regional GTFS feeds across three modes: Timeline (multi-year scrubber), Diff (pairwise Git-like comparison), and Scenario (edits layered on a baseline).

## 1. Three modes

| Mode | Inputs | Primary UI | Question it answers |
|---|---|---|---|
| **Timeline** | N feeds (e.g. VOR 2020–2026) | Map + year slider + metric chart | *"Show me the network in April 2023"*, *"How did coverage evolve?"* |
| **Diff** | Feed A vs Feed B | Map with green/red/amber overlays + text diff drawer | *"What exactly changed between 2022 and 2024?"* |
| **Scenario** | Baseline + JSON patch | Map edit tools + auto-diff against baseline | *"If we add this line, what's the effect?"* |

Switch is a tab in the top bar. All three modes share the same map, inspector, and metrics components.

## 2. Core technical contribution: cross-feed entity identity

`stop_id`, `route_id`, and `trip_id` are not stable across GTFS releases — agencies (including VOR) regenerate them. A timeline or longitudinal metric that joins by raw ID is broken by construction.

**Entity Registry** — on ingest of each feed, compute a stable canonical ID per entity using a multi-signal matcher:

- **Stops**: spatial clustering (DBSCAN ~20–30 m) + name normalization (umlaut-fold, strip "Bahnhof"/"Hauptbahnhof" variations) + platform disambiguation.
- **Routes**: `(agency, route_short_name, route_type)` as primary; shape-overlap Jaccard as fallback.
- **Patterns**: hash of ordered canonical stop IDs within a route.

Registry is persistent (OPFS) and extended on each feed ingest. Manual override UI for ambiguous matches. All downstream views join through the registry, not raw GTFS IDs.

Evaluation: hand-label a sample of matches across 3 VOR years, report precision/recall. This gives the thesis its rigor.

## 3. Austrian data — practicalities

| Region | Rough size (unzipped) | Notes |
|---|---|---|
| Vorarlberg | ~30–80 MB | Easy; good for prototyping |
| Kärnten | ~50–100 MB | Easy |
| VOR (Wien+NÖ+Bgld) | ~500 MB – 1.5 GB | `stop_times.txt` is the pain point (10–30M rows) |

**Ingest quirks**: BOM-prefixed CSVs, inconsistent `agency_timezone`, `shapes.txt` sometimes missing (need fallback geometry synthesis from stop sequences), VOR mixes sub-agencies (ÖBB, WL, Postbus).

**Performance strategy**: on first load, transcode CSVs into columnar Parquet shards in OPFS. Subsequent opens are near-instant. Makes 7 years × VOR tolerable in-browser.

Sources: [data.gv.at](https://www.data.gv.at), `mobilitaetsverbuende.at`.

## 4. Timeline mode specifics

- Continuous year slider (interpolates to "feed whose validity covers this date").
- Play/pause animation for demos.
- **Locked-entity mode**: pin a stop/route, slider drives inspector showing its attribute changes over time. Killer demo.
- Metrics overlay strip under the slider: total stops, service-km/day, route count.
- **Difference-to-baseline toggle**: highlight entities absent in the baseline year (visualize network growth).

## 5. Diff mode

Semantic entity-level diff on the Entity Registry IR, not text-level ID diff. Categories per entity type:

- **Stops**: added / removed / moved / renamed / unchanged.
- **Routes**: added / removed / renumbered / re-shaped / unchanged.
- **Patterns**: added / removed / extended / truncated / rerouted.
- **Calendar/service**: per-date bitmap diff.

Map overlays green/red/amber. Right inspector shows A vs B side-by-side with changed fields highlighted. Bottom drawer: Monaco text diff over raw `.txt` files, metrics dashboard, human-readable changelog.

## 6. Scenario mode

Scenarios are JSON patches on a baseline feed:

```json
{ "baseline": "vor_2024",
  "ops": [
    {"op":"add","entity":"route","data":{...}},
    {"op":"modify","entity":"stop","canonicalId":"...","patch":{"lat":...}},
    {"op":"remove","entity":"trip_pattern","id":"..."} ] }
```

Applying the patch produces a synthetic feed that flows through the same diff engine. MVP edit set: add/move/remove stop, disable route, duplicate-and-modify route.

## 7. Architecture

| Concern | Choice | Alternative | Why |
|---|---|---|---|
| Execution | Client-heavy SPA, backend optional | Full backend | Thesis demos better offline; feeds fit in browser for Austrian scope |
| Data engine | DuckDB-WASM | SQLite-WASM, IndexedDB | Reads CSV natively, columnar, fast joins over `stop_times` |
| Frontend | React + TypeScript + Vite | SvelteKit | Ecosystem for map/diff libs |
| Map | MapLibre GL JS + deck.gl | Leaflet | Vector tiles + GPU for 100k+ stops |
| Base tiles | MapTiler / OSM via MapLibre demo tiles | Self-host | Cheapest for thesis |
| Text diff UI | Monaco Editor diff mode | react-diff-viewer | Handles large files |
| Persistence | OPFS (browser) + JSON export | Server DB | Shareable scenarios as files |
| Optional backend | Python + FastAPI if routing/isochrones added | — | OpenTripPlanner or r5py for travel-time |

## 8. UI layout

```
┌─────────────────────────────────────────────────────────┐
│ Top bar: [Timeline | Diff | Scenario] │ feeds │ export  │
├──────────────┬──────────────────────────────┬───────────┤
│ Left panel   │                              │ Right     │
│ • Layers     │         MAP (80% vp)         │ Inspector │
│ • Filters    │    MapLibre + deck.gl        │ • Stop/   │
│ • Summary    │    added=green removed=red   │   route   │
│              │    modified=amber            │ • Before/ │
│              │                              │   after   │
├──────────────┴──────────────────────────────┴───────────┤
│ Bottom drawer (collapsible): raw text diff (Monaco) +   │
│ metrics tabs + changelog                                │
└─────────────────────────────────────────────────────────┘
```

Map is always primary. Everything else docks around it and collapses.

## 9. Persistence (OPFS)

```
/feeds/
  vor_2020/raw.zip
  vor_2020/shards/*.parquet      ← built on first ingest
  vor_2020/feed_info.json
  ...
/registry/
  canonical_entities.parquet     ← cross-feed identity table
  overrides.json                 ← user manual matches
/scenarios/
  my_scenario_1.json             ← patches, exportable
```

Import/export as files for thesis reproducibility. No server required.

## 10. Roadmap

**M1 — Ingest + Timeline skeleton (3 wks)**
DuckDB-WASM loader, OPFS persistence, Parquet shard build, MapLibre render of stops + shapes, feed switcher (discrete jump, no slider yet).

**M2 — Entity Registry v1 (3–4 wks)** ⭐ thesis core
Spatial + name matcher for stops, route matcher, registry UI with override tool. Evaluation harness with hand-labeled truth set.

**M3 — Timeline slider + locked entity (2 wks)**
Year slider, animated play, metrics strip, entity-pin.

**M4 — Diff mode (3 wks)**
IR-level diff over registry, map color overlays, inspector A/B, Monaco text-diff drawer.

**M5 — Metrics & longitudinal analytics (3 wks)**
Per-region/per-route time series, coverage areas, service-hour evolution.

**M6 — Scenario mode (3–4 wks)**
Patch format, edit UI, scenario-vs-baseline diff.


## 11. Thesis research questions (pick 2–3)

1. *How can developments of public transport systems be tracked and their impact on connectivity be visualized and measured?*
2. *How does scenario-based diffing, grounded in historical trajectory, compare to standalone scenario planning?* 
