import { create } from 'zustand';
import { MODES, type Mode } from '../gtfs/modes';
import { removeFeedFromOPFS } from '../gtfs/opfs';
import type { StopStatus, RouteStatus } from '../diff/engine';
import type { GeomStatus } from '../gtfs/segment-graph';
import { yearOfFeed } from '../timeline/math';

export type AppMode = 'timeline' | 'diff';

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

export interface AppState {
  mode: AppMode;
  setMode: (m: AppMode) => void;

  feeds: Record<string, FeedMeta>;
  feedOrder: string[];
  activeFeedId: string | null;
  compareFeedId: string | null;

  addFeed: (meta: FeedMeta) => void;
  removeFeed: (id: string) => void;
  setActiveFeed: (id: string | null) => void;
  setCompareFeed: (id: string | null) => void;

  /**
   * The inspector has two independent slots (stop + route) so the user can
   * see a station's detail *and* the currently selected line that serves
   * it side-by-side, matching the classic "click a stop → click one of its
   * lines" interaction.
   */
  inspectorStop: StopInspectorRef | null;
  inspectorRoute: RouteInspectorRef | null;
  setInspectorStop: (ref: StopInspectorRef | null) => void;
  setInspectorRoute: (ref: RouteInspectorRef | null) => void;
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
  /** Selected year (integer). Null until feeds are known; then snaps to one of them. */
  timelineYear: number | null;
  setTimelineYear: (year: number | null) => void;

  /** A pinned canonical entity whose history is shown in the inspector across years. */
  pinnedEntity: PinnedEntity | null;
  setPinnedEntity: (p: PinnedEntity | null) => void;

  // Diff mode ---------------------------------------------------------------
  /** Which change categories to show on the map / in the lists. */
  diffStopVisibility: Record<StopStatus, boolean>;
  toggleDiffStopVisibility: (s: StopStatus) => void;
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
   * Per-status total segment length in metres, updated by the map after it
   * builds the segment diff. Lives in the store (rather than being
   * recomputed in the sidebar) to avoid running the expensive resample +
   * spatial-grid pass twice.
   */
  diffSegmentSummary:
    | { feedA: string; feedB: string; lengths: Record<GeomStatus, number> }
    | null;
  setDiffSegmentSummary: (
    s:
      | { feedA: string; feedB: string; lengths: Record<GeomStatus, number> }
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
  setDiffStopFocus: (canonicalId: string | null) => void;
  setDiffRouteFocus: (canonicalId: string | null) => void;
  clearDiffFocus: () => void;
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
  mode: 'timeline',
  setMode: (mode) =>
    set((s) => {
      const cleared = { diffStopFocus: null, diffRouteFocus: null } as const;
      if (mode !== 'diff') return { mode, ...cleared };
      if (s.feedOrder.length < 2) return { mode, compareFeedId: null, ...cleared };
      // Preserve an explicit pair the user already set up via the diff
      // sidebar (they may want a non-standard ordering for a specific
      // comparison). Otherwise, default to the canonical
      // older-A → newer-B layout so "added" / "removed" read as
      // changes from the past to the present.
      if (s.compareFeedId && s.compareFeedId !== s.activeFeedId) {
        return { mode, ...cleared };
      }
      const sorted = [...s.feedOrder].sort(
        (a, b) => yearOfFeed(s.feeds[a]).year - yearOfFeed(s.feeds[b]).year,
      );
      const oldest = sorted[0] ?? null;
      const newest = sorted[sorted.length - 1] ?? null;
      if (!oldest || !newest || oldest === newest) {
        return { mode, compareFeedId: null, ...cleared };
      }
      return {
        mode,
        activeFeedId: oldest,
        compareFeedId: newest,
        inspectorStop: null,
        inspectorRoute: null,
        ...cleared,
      };
    }),

  feeds: {},
  feedOrder: [],
  activeFeedId: null,
  compareFeedId: null,

  addFeed: (meta) =>
    set((s) => ({
      feeds: { ...s.feeds, [meta.id]: meta },
      feedOrder: s.feedOrder.includes(meta.id) ? s.feedOrder : [...s.feedOrder, meta.id],
      activeFeedId: s.activeFeedId ?? meta.id,
    })),
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
  inspectorStop: null,
  inspectorRoute: null,
  setInspectorStop: (inspectorStop) => set({ inspectorStop }),
  setInspectorRoute: (inspectorRoute) => set({ inspectorRoute }),
  clearInspector: () => set({ inspectorStop: null, inspectorRoute: null }),

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

  timelineYear: null,
  setTimelineYear: (timelineYear) => set({ timelineYear }),

  pinnedEntity: null,
  setPinnedEntity: (pinnedEntity) => set({ pinnedEntity }),

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
  },
  toggleDiffSegmentVisibility: (s) =>
    set((st) => ({
      diffSegmentVisibility: {
        ...st.diffSegmentVisibility,
        [s]: !st.diffSegmentVisibility[s],
      },
    })),
  diffSegmentSummary: null,
  setDiffSegmentSummary: (diffSegmentSummary) => set({ diffSegmentSummary }),
  diffStopFocus: null,
  diffRouteFocus: null,
  setDiffStopFocus: (diffStopFocus) => set({ diffStopFocus }),
  setDiffRouteFocus: (diffRouteFocus) => set({ diffRouteFocus }),
  clearDiffFocus: () => set({ diffStopFocus: null, diffRouteFocus: null }),
}));
