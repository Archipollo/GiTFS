import { create } from 'zustand';
import { MODES, type Mode } from '../gtfs/modes';
import { removeFeedFromOPFS } from '../gtfs/opfs';
import type { StopStatus, RouteStatus } from '../diff/engine';
import type { GeomStatus } from '../gtfs/segment-graph';
import { yearOfFeed } from '../timeline/math';
import type { PopulationSummary } from '../gtfs/population';
import type { GueteklassenSummary } from '../gtfs/gueteklassen';
import type { GueteklassenChangeSummary } from '../diff/gueteklassen';
import type { FrequencyClassMode } from '../diff/frequency';
import type { PopulationClassMode } from '../diff/population';

export interface FeedMeta {
  id: string;
  label: string;
  sourceName: string;
  loadedAt: number;
  stopCount?: number;
  routeCount?: number;
  tripCount?: number;
  feedStartDate?: string;
  feedEndDate?: string;
}

/** Timeline-mode stop slot: identifies a raw stop in the active feed. */
export interface StopInspectorRef {
  feedId: string;
  rawId: string;
  stopName: string;
  modes: Mode[];
  canonicalId?: string | null;
}

/**
 * Timeline-mode route slot. Identified by raw route_id within a feed. The
 * optional `shapeId` is the shape the user clicked (if any) so the map can
 * draw the matching polyline overlay.
 */
export interface RouteInspectorRef {
  feedId: string;
  rawId: string;
  shapeId?: string | null;
  canonicalId?: string | null;
}

/** All routes sharing a clicked map segment — shown in SegmentCard. */
export interface SegmentInspectorRef {
  feedId: string;
  shapeId: string;
  routeIds: string[];
}

export interface RegistryFocus {
  kind: 'stop' | 'route';
  canonicalId: string;
  /** Pre-computed anchor point for the map; undefined for route canonicals. */
  lat?: number;
  lon?: number;
}

export interface RegistryProgress {
  stage: string;
  step: number;
  total: number;
  feedLabel?: string;
}

export interface PinnedEntity {
  kind: 'stop' | 'route';
  canonicalId: string;
  /** Human label for the pin chip. */
  label: string;
}

export type MapStyle = 'standard' | 'voyager' | 'dark' | 'positron';

/** Persisted map camera, shared across the overview maps (network / split /
 *  timeline) so switching layouts keeps the user's current view instead of
 *  resetting to the all-Austria default. In-memory only — a page reload starts
 *  fresh and lets the first auto-fit run. */
export interface MapCamera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

/** The active analysis overlay — see the doc comment on `analysisMode`
 * below for what each mode does. Exported so every consumer (menu, map
 * views) can share one union instead of repeating it inline. */
export type AnalysisMode = 'none' | 'frequency' | 'population' | 'gueteklassen';

export interface AppState {
  /** Re-runs the oldest/newest-feed diff-pair auto-pick, run once at boot and
   *  whenever the loaded feed set changes. */
  autoPairDiffFeeds: () => void;

  mapStyle: MapStyle;
  setMapStyle: (s: MapStyle) => void;

  /** Whether the era-matched Wayback satellite basemap is active. Overrides `mapStyle`. */
  historicalBasemap: boolean;
  setHistoricalBasemap: (v: boolean) => void;

  feeds: Record<string, FeedMeta>;
  feedOrder: string[];
  activeFeedId: string | null;
  compareFeedId: string | null;

  addFeed: (meta: FeedMeta) => void;
  removeFeed: (id: string) => void;
  setActiveFeed: (id: string | null) => void;
  setCompareFeed: (id: string | null) => void;

  /** TopBar feed-info popover (feed list + metadata) open/closed. */
  feedBarOpen: boolean;
  setFeedBarOpen: (v: boolean) => void;

  /**
   * The inspector has two independent slots (stop + route) so the user can
   * see a station's detail *and* the currently selected line that serves
   * it side-by-side, matching the classic "click a stop → click one of its
   * lines" interaction.
   */
  inspectorStop: StopInspectorRef | null;
  inspectorRoute: RouteInspectorRef | null;
  inspectorSegment: SegmentInspectorRef | null;
  setInspectorStop: (ref: StopInspectorRef | null) => void;
  setInspectorRoute: (ref: RouteInspectorRef | null) => void;
  setInspectorSegment: (ref: SegmentInspectorRef | null) => void;
  clearInspector: () => void;

  ingesting: { id: string; progress: string } | null;
  setIngesting: (v: AppState['ingesting']) => void;

  showStops: boolean;
  setShowStops: (v: boolean) => void;

  modeVisibility: Record<Mode, boolean>;
  toggleModeVisibility: (m: Mode) => void;

  // Map-task tracker: any entry here means the map overlay spinner is shown.
  // Keyed so multiple concurrent tasks (rehydrate + per-feed load) can coexist.
  mapTasks: Record<string, string>;
  beginMapTask: (id: string, label: string) => void;
  setMapTaskLabel: (id: string, label: string) => void;
  endMapTask: (id: string) => void;

  // Registry build progress (null = idle).
  registryProgress: RegistryProgress | null;
  setRegistryProgress: (p: RegistryProgress | null) => void;

  // Registry focus: a selected canonical entity to highlight on the map.
  registryFocus: RegistryFocus | null;
  setRegistryFocus: (f: RegistryFocus | null) => void;

  // Timeline mode ----------------------------------------------------------
  /**
   * Selected feed (by id), not year — two feeds can share a representative
   * year, so the year alone can't identify which one is selected. Null
   * until feeds are known; then snaps to one of them.
   */
  timelineFeedId: string | null;
  setTimelineFeedId: (feedId: string | null) => void;

  /** Pinned canonical entities whose histories are shown in the inspector across years. */
  pinnedEntities: PinnedEntity[];
  addPinnedEntity: (p: PinnedEntity) => void;
  removePinnedEntity: (canonicalId: string) => void;

  // Diff mode ---------------------------------------------------------------
  /** Which change categories to show on the map / in the lists. */
  diffStopVisibility: Record<StopStatus, boolean>;
  toggleDiffStopVisibility: (s: StopStatus) => void;
  /** Show station-name labels beneath stop dots (gated by zoom on the map). */
  diffStopLabels: boolean;
  toggleDiffStopLabels: () => void;
  /**
   * Lines in diff mode are compared at the geometry level (added / removed
   * / unchanged segments), so the per-route-entity statuses from the
   * engine (`added/removed/modified/renumbered/unchanged`) no longer map
   * cleanly onto map visibility. We keep those available for future
   * drawer filtering (see `diffRouteVisibility`) but the map actually
   * renders using `diffSegmentVisibility`.
   */
  diffSegmentVisibility: Record<GeomStatus, boolean>;
  toggleDiffSegmentVisibility: (s: GeomStatus) => void;
  /**
   * The active analysis overlay, available from every view (network overview,
   * split view, route detail, and plain single-feed/timeline browsing) via the
   * global Analysis menu in the top bar — not tied to diff mode. `'none'`
   * means the ordinary geometry/status rendering is shown. An extensible
   * string union so a future mode (e.g. `'population'`) slots in without
   * touching any consumer's plumbing.
   *
   * Where a diff pair exists, `'frequency'` shows the trips/week gained or
   * lost per route (mutually exclusive with the geometry-diff overlay — both
   * drawn from overlapping shape data, so showing both at once would be
   * unreadable). Where there's no diff pair (single-feed/timeline view),
   * `'frequency'` shows each route's absolute trips/week instead.
   */
  analysisMode: AnalysisMode;
  setAnalysisMode: (m: AnalysisMode) => void;
  /**
   * Which dataset backs the population overlay: `'ghs'` (GHS-POP global
   * raster, default — the only source with a year-over-year series, so it's
   * what diff mode's gained/lost overlay uses) or `'zsp'` (Statistik
   * Austria's Zählsprengel registry counts on real boundaries — Austria-only,
   * a single current snapshot with no per-feed-year comparison). See
   * gtfs/zaehlsprengel.ts.
   */
  populationSource: 'ghs' | 'zsp';
  setPopulationSource: (s: 'ghs' | 'zsp') => void;
  /**
   * Whether added/removed routes (100%-swing deltas, since one side is 0)
   * are included in the diff-mode frequency overlay's scale and rendering.
   * Off by default — they otherwise stretch the scale so far that real
   * frequency changes render thin and washed-out.
   */
  frequencyIncludeAddedRemoved: boolean;
  setFrequencyIncludeAddedRemoved: (v: boolean) => void;
  /**
   * Which fixed scale classifies a route's frequency change: relative to its
   * own baseline (percent) or a flat trips/week amount. Both use fixed
   * breakpoints, so switching this (or `frequencyIncludeAddedRemoved`) never
   * shifts the legend's class boundaries.
   */
  frequencyClassMode: FrequencyClassMode;
  setFrequencyClassMode: (v: FrequencyClassMode) => void;
  /**
   * Which fixed scale colours the network-diff population overlay:
   * loss/gain per cell (`'change'`, the default) or feed B's absolute
   * density (`'density'`), so a viewer can see general density without
   * leaving diff mode. Mirrors `frequencyClassMode` above.
   */
  populationClassMode: PopulationClassMode;
  setPopulationClassMode: (v: PopulationClassMode) => void;
  /**
   * Frequency-overlay legend data for diff mode, updated by the map after it
   * computes the trips/week diff — mirrors `diffSegmentSummary`'s "compute
   * once on the map, read from the sidebar" split.
   */
  diffFrequencySummary:
    | {
        feedA: string;
        feedB: string;
        maxAbsDelta: number;
        scaleAbsDelta: number;
        routeCount: number;
      }
    | null;
  setDiffFrequencySummary: (
    s:
      | {
          feedA: string;
          feedB: string;
          maxAbsDelta: number;
          scaleAbsDelta: number;
          routeCount: number;
        }
      | null,
  ) => void;
  /**
   * Frequency-overlay legend data for the no-diff-pair case (single-feed or
   * timeline browsing): absolute trips/week per route, not a delta.
   */
  feedFrequencySummary:
    | {
        feedId: string;
        maxWeeklyTrips: number;
        scaleWeeklyTrips: number;
        routeCount: number;
      }
    | null;
  setFeedFrequencySummary: (
    s:
      | {
          feedId: string;
          maxWeeklyTrips: number;
          scaleWeeklyTrips: number;
          routeCount: number;
        }
      | null,
  ) => void;
  /**
   * Population-overlay legend data for a diff pair — the per-cell population
   * delta between feed A's and feed B's nearest GHS-POP year. Mirrors
   * `diffFrequencySummary`'s "compute once on the map, read from the
   * sidebar" split.
   */
  diffPopulationSummary:
    | {
        feedA: string;
        feedB: string;
        yearA: number;
        yearB: number;
        mode: 'delta' | 'absolute';
        maxAbsDelta: number;
        scaleAbsDelta: number;
        maxPopulation: number;
        scalePopulation: number;
        cellCount: number;
        cellSizeMeters: number;
      }
    | null;
  setDiffPopulationSummary: (
    s:
      | {
          feedA: string;
          feedB: string;
          yearA: number;
          yearB: number;
          mode: 'delta' | 'absolute';
          maxAbsDelta: number;
          scaleAbsDelta: number;
          maxPopulation: number;
          scalePopulation: number;
          cellCount: number;
          cellSizeMeters: number;
        }
      | null,
  ) => void;
  /**
   * Population-overlay legend data for the no-diff-pair case: absolute
   * population per cell for the active feed's nearest GHS-POP year.
   */
  feedPopulationSummary:
    | {
        year: number;
        maxPopulation: number;
        scalePopulation: number;
        cellCount: number;
        cellSizeMeters: number;
      }
    | null;
  setFeedPopulationSummary: (
    s:
      | {
          year: number;
          maxPopulation: number;
          scalePopulation: number;
          cellCount: number;
          cellSizeMeters: number;
        }
      | null,
  ) => void;
  /**
   * Population-overlay legend data for split view's per-pane absolute GHS-POP
   * display — unlike `diffPopulationSummary`, split view never diffs
   * population between the two feed years (each pane shows its own year's
   * raw numbers), so this holds one `PopulationSummary` per side instead of
   * a single delta/absolute summary. Either side is null until that pane has
   * finished its own compute.
   */
  splitPopulationSummary: { a: PopulationSummary | null; b: PopulationSummary | null };
  setSplitPopulationSummary: (side: 'a' | 'b', summary: PopulationSummary | null) => void;
  /**
   * Population-overlay legend data when `populationSource === 'zsp'` — used
   * by every view (single-feed, split, network-diff) alike, since the
   * Zählsprengel source has no per-feed-year diff (see
   * gtfs/zaehlsprengel.ts).
   */
  zaehlsprengelPopulationSummary:
    | {
        year: number;
        maxPopulation: number;
        scalePopulation: number;
        unitCount: number;
      }
    | null;
  setZaehlsprengelPopulationSummary: (
    s:
      | {
          year: number;
          maxPopulation: number;
          scalePopulation: number;
          unitCount: number;
        }
      | null,
  ) => void;
  /**
   * ÖV-Güteklassen-overlay legend data for the no-diff-pair case: absolute
   * A-G class counts for the active feed. Mirrors `feedPopulationSummary`.
   */
  feedGueteklassenSummary: GueteklassenSummary | null;
  setFeedGueteklassenSummary: (s: GueteklassenSummary | null) => void;
  /**
   * ÖV-Güteklassen-overlay legend data for split view's per-pane absolute
   * display — like population's split summary, each pane shows its own
   * feed's classes independently (A-G is ordinal, not subtractable, so
   * there's no per-cell delta to show instead). Either side is null until
   * that pane has finished its own compute.
   */
  splitGueteklassenSummary: { a: GueteklassenSummary | null; b: GueteklassenSummary | null };
  setSplitGueteklassenSummary: (side: 'a' | 'b', summary: GueteklassenSummary | null) => void;
  /**
   * ÖV-Güteklassen-overlay legend data for the network-diff overview: counts
   * per categorical change (improved/degraded/unchanged/gained/lost) between
   * feed A's and feed B's classes.
   */
  diffGueteklassenSummary: GueteklassenChangeSummary | null;
  setDiffGueteklassenSummary: (s: GueteklassenChangeSummary | null) => void;
  /**
   * Per-status total segment length in metres, updated by the map after it
   * builds the segment diff. Lives in the store (rather than being
   * recomputed in the sidebar) to avoid running the expensive resample +
   * spatial-grid pass twice.
   */
  diffSegmentSummary:
    | {
        feedA: string;
        feedB: string;
        lengths: Record<GeomStatus, number>;
        routeLengths: { removed: number; added: number };
      }
    | null;
  setDiffSegmentSummary: (
    s:
      | {
          feedA: string;
          feedB: string;
          lengths: Record<GeomStatus, number>;
          routeLengths: { removed: number; added: number };
        }
      | null,
  ) => void;
  diffRouteVisibility: Record<RouteStatus, boolean>;
  toggleDiffRouteVisibility: (s: RouteStatus) => void;
  /**
   * Diff-mode inspector focus. Two independent canonical slots (stop + route)
   * mirror the timeline-mode `inspectorStop` / `inspectorRoute` pair so the
   * inspector can show "removed stop X + the line it used to serve on feed A"
   * simultaneously.
   *
   * Route focus may be a renumbered-pair synthetic id (`ren__fromCid__toCid`);
   * consumers that need the underlying route(s) should decode by splitting.
   */
  diffStopFocus: string | null;
  diffRouteFocus: string | null;
  /**
   * Other canonical routes found at the point that was last clicked to set
   * `diffRouteFocus` (always includes the focused id itself). Lets the
   * inspector offer a switcher when several lines overlap on screen —
   * clicking a line no longer commits to just the topmost one.
   */
  diffRouteCandidates: string[];
  /**
   * `geom_status` of the map segment that was actually clicked to set
   * `diffRouteFocus`, when known. Distinct from the route's own entity
   * status (added/removed/modified/unchanged): a route can be identity-
   * `unchanged` while this particular stretch of its path is new or
   * removed geometry (a reroute). Lets the inspector flag that mismatch
   * instead of presenting them as if they were the same thing.
   */
  diffRouteFocusGeomStatus: 'unchanged' | 'added' | 'removed' | 'changed' | null;
  /**
   * Canonical route ids that have at least one non-`unchanged` geometry run
   * somewhere along their path, computed once per feed pair from the
   * segment diff. A route can be identity-`unchanged` yet have taken a
   * different path on some stretch — the inspector uses this to avoid
   * calling such a route "unchanged" when its geometry plainly isn't.
   */
  diffRoutesWithGeomChange: Set<string> | null;
  setDiffRoutesWithGeomChange: (s: Set<string> | null) => void;
  /**
   * Canonical route id → the `direction_id`s whose geometry can actually be
   * isolated on the map (i.e. the route pair was splittable by direction, so
   * its runs carry a real direction_id — see `diffShapesByRoute`). Empty/absent
   * means the line can only be shown as "Entire line". Drives which direction
   * sub-rows the line-list offers and the detail view's direction filter.
   */
  diffRouteDirections: Map<string, number[]> | null;
  setDiffRouteDirections: (m: Map<string, number[]> | null) => void;
  setDiffStopFocus: (canonicalId: string | null) => void;
  /** `candidates` defaults to `[canonicalId]` when omitted or null is passed. */
  setDiffRouteFocus: (
    canonicalId: string | null,
    candidates?: string[],
    geomStatus?: 'unchanged' | 'added' | 'removed' | 'changed' | null,
  ) => void;
  clearDiffFocus: () => void;
  /**
   * Bumped to request that MapView zoom/fit the camera to the full extent of
   * the currently focused diff route. Clicking a line only opens the
   * inspector and highlights it in place; zooming out is an explicit,
   * separate action (the "Show full line" button in the inspector).
   */
  diffRouteZoomToken: number;
  requestDiffRouteZoom: () => void;

  /**
   * Which top-level layout the diff map area shows: the two-map synchronized
   * overview (all lines, split old/new) or the single-map detail view for
   * one focused route. Clicking a line-list row or a map segment opens
   * detail; the detail view's back button (or clearing the route focus)
   * returns to overview.
   */
  diffViewMode: 'overview' | 'detail';
  setDiffViewMode: (m: 'overview' | 'detail') => void;
  /**
   * Orthogonal to `diffViewMode`: within the overview, whether to show a
   * single full-network map (all statuses at once, the default) or the
   * synced old/new split view. Detail view is unaffected by this toggle.
   */
  diffOverviewLayout: 'single' | 'split' | 'timeline';
  setDiffOverviewLayout: (l: 'single' | 'split' | 'timeline') => void;
  /**
   * Last camera the overview maps (network / split / timeline) were left at.
   * Written on `moveend`, read once when a map is (re)constructed so switching
   * layouts preserves the current view. Null until the first pan/zoom.
   */
  mapCamera: MapCamera | null;
  setMapCamera: (c: MapCamera) => void;
  /**
   * Detail-view mode switch: show both feeds' geometry colored by diff
   * status, or isolate just the old (feed A) or new (feed B) alignment.
   */
  diffDetailMode: 'colored' | 'old' | 'new';
  setDiffDetailMode: (m: 'colored' | 'old' | 'new') => void;
  /**
   * Detail-view direction filter: `null` = "Entire line" (union of both
   * directions, the default), or a specific `direction_id` to isolate one
   * direction's geometry. Reset to `null` whenever the focused route changes
   * so switching lines never carries a stale direction over.
   */
  diffDirectionFocus: number | null;
  setDiffDirectionFocus: (dir: number | null) => void;

  /**
   * Year to use for the Wayback satellite basemap in diff mode.
   * Null = follow feed A's year (default). Setting this never affects
   * the A/B feed pair — only the background imagery changes.
   */
  diffBasemapYear: number | null;
  setDiffBasemapYear: (year: number | null) => void;
}

/**
 * Points the diff A/B pair at the oldest and newest loaded feed.
 *
 * The whole diff reads A as "before" and B as "after" — geometry only in A is
 * `removed`, only in B is `added`, and a reroute draws A's alignment dotted
 * against B's solid. Nothing downstream re-derives that from the feed dates,
 * so a backwards pair silently inverts every old/new label on the map. Rather
 * than warn about it, we always establish the chronological pair whenever the
 * set of loaded feeds changes; the user can still override the slots by hand
 * afterwards, and that choice stands until the next feed is loaded.
 *
 * Sorts on `repDate`, not `year`, so two feeds from the same year still order
 * correctly.
 */
function autoPairDiffFeedsPatch(s: AppState): Partial<AppState> {
  if (s.feedOrder.length < 2) return { compareFeedId: null };
  const sorted = [...s.feedOrder].sort(
    (a, b) => yearOfFeed(s.feeds[a]).repDate.getTime() - yearOfFeed(s.feeds[b]).repDate.getTime(),
  );
  const oldest = sorted[0] ?? null;
  const newest = sorted[sorted.length - 1] ?? null;
  if (!oldest || !newest || oldest === newest) return { compareFeedId: null };
  return {
    activeFeedId: oldest,
    compareFeedId: newest,
    inspectorStop: null,
    inspectorRoute: null,
  };
}

export function selectMapBusy(s: AppState): boolean {
  if (s.ingesting) return true;
  if (s.registryProgress) return true;
  return Object.keys(s.mapTasks).length > 0;
}

export function selectMapBusyLabel(s: AppState): string {
  if (s.ingesting) return s.ingesting.progress;
  if (s.registryProgress) {
    const rp = s.registryProgress;
    const feed = rp.feedLabel ? ` (${rp.feedLabel})` : '';
    return `Registry: ${rp.stage}${feed} — ${rp.step}/${rp.total}`;
  }
  const keys = Object.keys(s.mapTasks);
  if (keys.length === 0) return '';
  return s.mapTasks[keys[keys.length - 1]];
}

export const useAppStore = create<AppState>((set) => ({
  mapStyle: 'positron',
  setMapStyle: (mapStyle) => set({ mapStyle }),

  historicalBasemap: false,
  setHistoricalBasemap: (historicalBasemap) => set({ historicalBasemap }),

  autoPairDiffFeeds: () => set((s) => autoPairDiffFeedsPatch(s)),

  feeds: {},
  feedOrder: [],
  activeFeedId: null,
  compareFeedId: null,

  addFeed: (meta) =>
    set((s) => {
      const next: AppState = {
        ...s,
        feeds: { ...s.feeds, [meta.id]: meta },
        feedOrder: s.feedOrder.includes(meta.id) ? s.feedOrder : [...s.feedOrder, meta.id],
        activeFeedId: s.activeFeedId ?? meta.id,
      };
      // Re-derive the chronological A/B pair against the enlarged feed set: a
      // newly loaded feed can be the new oldest or newest, and leaving the old
      // pair in place is what lets A end up holding the later feed.
      return { ...next, ...autoPairDiffFeedsPatch(next) };
    }),
  removeFeed: (id) => {
    removeFeedFromOPFS(id).catch((err) => console.warn('OPFS remove failed', err));
    set((s) => {
      const { [id]: _gone, ...rest } = s.feeds;
      void _gone;
      return {
        feeds: rest,
        feedOrder: s.feedOrder.filter((x) => x !== id),
        activeFeedId: s.activeFeedId === id ? null : s.activeFeedId,
        compareFeedId: s.compareFeedId === id ? null : s.compareFeedId,
      };
    });
  },
  setActiveFeed: (id) =>
    set((s) => ({
      activeFeedId: id,
      compareFeedId: id !== null && s.compareFeedId === id ? null : s.compareFeedId,
      inspectorStop: null,
      inspectorRoute: null,
    })),
  setCompareFeed: (id) =>
    set((s) => ({
      compareFeedId: id === s.activeFeedId ? null : id,
    })),

  feedBarOpen: false,
  setFeedBarOpen: (feedBarOpen) => set({ feedBarOpen }),

  inspectorStop: null,
  inspectorRoute: null,
  inspectorSegment: null,
  setInspectorStop: (inspectorStop) => set({ inspectorStop, inspectorSegment: null }),
  setInspectorRoute: (inspectorRoute) => set({ inspectorRoute, inspectorSegment: null }),
  setInspectorSegment: (inspectorSegment) => set({ inspectorSegment, inspectorRoute: null }),
  clearInspector: () => set({ inspectorStop: null, inspectorRoute: null, inspectorSegment: null }),

  ingesting: null,
  setIngesting: (v) => set({ ingesting: v }),

  showStops: true,
  setShowStops: (v) => set({ showStops: v }),

  modeVisibility: Object.fromEntries(MODES.map((m) => [m, true])) as Record<Mode, boolean>,
  toggleModeVisibility: (m) =>
    set((s) => ({ modeVisibility: { ...s.modeVisibility, [m]: !s.modeVisibility[m] } })),

  mapTasks: {},
  beginMapTask: (id, label) =>
    set((s) => ({ mapTasks: { ...s.mapTasks, [id]: label } })),
  setMapTaskLabel: (id, label) =>
    set((s) => (s.mapTasks[id] === undefined ? s : { mapTasks: { ...s.mapTasks, [id]: label } })),
  endMapTask: (id) =>
    set((s) => {
      if (s.mapTasks[id] === undefined) return s;
      const { [id]: _gone, ...rest } = s.mapTasks;
      void _gone;
      return { mapTasks: rest };
    }),

  registryProgress: null,
  setRegistryProgress: (p) => set({ registryProgress: p }),

  registryFocus: null,
  setRegistryFocus: (registryFocus) => set({ registryFocus }),

  timelineFeedId: null,
  setTimelineFeedId: (timelineFeedId) => set({ timelineFeedId }),

  pinnedEntities: [],
  addPinnedEntity: (p) =>
    set((s) => ({
      pinnedEntities: s.pinnedEntities.some((e) => e.canonicalId === p.canonicalId)
        ? s.pinnedEntities
        : [...s.pinnedEntities, p],
    })),
  removePinnedEntity: (canonicalId) =>
    set((s) => ({ pinnedEntities: s.pinnedEntities.filter((e) => e.canonicalId !== canonicalId) })),

  diffStopVisibility: {
    added: true,
    removed: true,
    moved: true,
    renamed: true,
    // Unchanged stops overwhelm the map; hide by default but let the user re-enable.
    unchanged: false,
  },
  toggleDiffStopVisibility: (s) =>
    set((st) => ({
      diffStopVisibility: { ...st.diffStopVisibility, [s]: !st.diffStopVisibility[s] },
    })),
  diffStopLabels: true,
  toggleDiffStopLabels: () => set((st) => ({ diffStopLabels: !st.diffStopLabels })),
  diffRouteVisibility: {
    added: true,
    removed: true,
    renumbered: true,
    modified: true,
    unchanged: false,
  },
  toggleDiffRouteVisibility: (s) =>
    set((st) => ({
      diffRouteVisibility: { ...st.diffRouteVisibility, [s]: !st.diffRouteVisibility[s] },
    })),
  diffSegmentVisibility: {
    added: true,
    removed: true,
    // Unchanged segments are the network background — on by default so the
    // user sees *where* the new/removed bits attach to the existing network.
    unchanged: true,
    changed: true,
  },
  toggleDiffSegmentVisibility: (s) =>
    set((st) => ({
      diffSegmentVisibility: {
        ...st.diffSegmentVisibility,
        [s]: !st.diffSegmentVisibility[s],
      },
    })),
  analysisMode: 'none',
  // Stops clutter the frequency overlay's line-color/width encoding, so
  // entering frequency mode defaults them off — both the single-feed/timeline
  // toggle (`showStops`) and every per-status diff-mode toggle
  // (`diffStopVisibility`). The user can still switch them back on via
  // whichever stops toggle their current view exposes.
  setAnalysisMode: (analysisMode) =>
    set((st) => {
      if (analysisMode === 'frequency') {
        return {
          analysisMode,
          showStops: false,
          diffStopVisibility: Object.fromEntries(
            Object.keys(st.diffStopVisibility).map((k) => [k, false]),
          ) as typeof st.diffStopVisibility,
        };
      }
      // Leaving frequency mode restores the identity-change categories
      // (added/removed/moved/renamed) that entering it turned off —
      // `unchanged` stays off, matching its own default.
      if (st.analysisMode === 'frequency') {
        return {
          analysisMode,
          showStops: true,
          diffStopVisibility: {
            ...st.diffStopVisibility,
            added: true,
            removed: true,
            moved: true,
            renamed: true,
          },
        };
      }
      return { analysisMode };
    }),
  frequencyIncludeAddedRemoved: false,
  setFrequencyIncludeAddedRemoved: (v) => set({ frequencyIncludeAddedRemoved: v }),
  frequencyClassMode: 'relative',
  setFrequencyClassMode: (v) => set({ frequencyClassMode: v }),
  populationClassMode: 'change',
  setPopulationClassMode: (v) => set({ populationClassMode: v }),
  diffFrequencySummary: null,
  setDiffFrequencySummary: (diffFrequencySummary) => set({ diffFrequencySummary }),
  feedFrequencySummary: null,
  setFeedFrequencySummary: (feedFrequencySummary) => set({ feedFrequencySummary }),
  populationSource: 'ghs',
  setPopulationSource: (populationSource) => set({ populationSource }),
  diffPopulationSummary: null,
  setDiffPopulationSummary: (diffPopulationSummary) => set({ diffPopulationSummary }),
  feedPopulationSummary: null,
  setFeedPopulationSummary: (feedPopulationSummary) => set({ feedPopulationSummary }),
  splitPopulationSummary: { a: null, b: null },
  setSplitPopulationSummary: (side, summary) =>
    set((s) => ({ splitPopulationSummary: { ...s.splitPopulationSummary, [side]: summary } })),
  zaehlsprengelPopulationSummary: null,
  setZaehlsprengelPopulationSummary: (zaehlsprengelPopulationSummary) => set({ zaehlsprengelPopulationSummary }),
  feedGueteklassenSummary: null,
  setFeedGueteklassenSummary: (feedGueteklassenSummary) => set({ feedGueteklassenSummary }),
  splitGueteklassenSummary: { a: null, b: null },
  setSplitGueteklassenSummary: (side, summary) =>
    set((s) => ({ splitGueteklassenSummary: { ...s.splitGueteklassenSummary, [side]: summary } })),
  diffGueteklassenSummary: null,
  setDiffGueteklassenSummary: (diffGueteklassenSummary) => set({ diffGueteklassenSummary }),
  diffSegmentSummary: null,
  setDiffSegmentSummary: (diffSegmentSummary) => set({ diffSegmentSummary }),
  diffStopFocus: null,
  diffRouteFocus: null,
  diffRouteCandidates: [],
  diffRouteFocusGeomStatus: null,
  diffRoutesWithGeomChange: null,
  setDiffRoutesWithGeomChange: (diffRoutesWithGeomChange) => set({ diffRoutesWithGeomChange }),
  diffRouteDirections: null,
  setDiffRouteDirections: (diffRouteDirections) => set({ diffRouteDirections }),
  setDiffStopFocus: (diffStopFocus) => set({ diffStopFocus }),
  setDiffRouteFocus: (diffRouteFocus, candidates, geomStatus) =>
    set({
      diffRouteFocus,
      diffRouteCandidates: diffRouteFocus == null ? [] : candidates ?? [diffRouteFocus],
      diffRouteFocusGeomStatus: diffRouteFocus == null ? null : geomStatus ?? null,
      // Changing the focused route always starts on "Entire line"; a caller
      // that wants a specific direction sets it right after this call.
      diffDirectionFocus: null,
      // Clearing the focus (e.g. the detail view's close button) also
      // returns to the split overview — mirrors the prototype's back-button
      // semantics for "nothing focused = show the overview".
      ...(diffRouteFocus == null ? { diffViewMode: 'overview' as const } : {}),
    }),
  clearDiffFocus: () => set({
    diffStopFocus: null,
    diffRouteFocus: null,
    diffRouteCandidates: [],
    diffRouteFocusGeomStatus: null,
    diffDirectionFocus: null,
    diffViewMode: 'overview',
  }),
  diffRouteZoomToken: 0,
  requestDiffRouteZoom: () => set((s) => ({ diffRouteZoomToken: s.diffRouteZoomToken + 1 })),

  diffViewMode: 'overview',
  setDiffViewMode: (diffViewMode) => set({ diffViewMode }),
  diffOverviewLayout: 'single',
  setDiffOverviewLayout: (diffOverviewLayout) => set({ diffOverviewLayout }),
  mapCamera: null,
  setMapCamera: (mapCamera) => set({ mapCamera }),
  diffDetailMode: 'colored',
  setDiffDetailMode: (diffDetailMode) => set({ diffDetailMode }),
  diffDirectionFocus: null,
  setDiffDirectionFocus: (diffDirectionFocus) => set({ diffDirectionFocus }),

  diffBasemapYear: null,
  setDiffBasemapYear: (diffBasemapYear) => set({ diffBasemapYear }),
}));
