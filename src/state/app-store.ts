import { create } from 'zustand';
import { MODES, type Mode } from '../gtfs/modes';
import { removeFeedFromOPFS } from '../gtfs/opfs';
import type { StopStatus, RouteStatus } from '../diff/engine';

export type AppMode = 'timeline' | 'diff' | 'scenario';

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

export type InspectorSelection =
  | { kind: 'stop'; stopId: string; stopName: string; modes: Mode[]; canonicalId?: string | null }
  | { kind: 'line'; shapeId: string; modes: Mode[] };

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
  inspectorSelection: InspectorSelection | null;
  setInspectorSelection: (selection: InspectorSelection | null) => void;

  drawerOpen: boolean;
  toggleDrawer: () => void;

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

  // Drawer
  drawerTab: 'registry' | 'metrics' | 'diff' | 'changelog';
  setDrawerTab: (t: AppState['drawerTab']) => void;

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
  diffRouteVisibility: Record<RouteStatus, boolean>;
  toggleDiffRouteVisibility: (s: RouteStatus) => void;
  /**
   * A canonical diff entry the user has focused from a list. The map should
   * fly to its representative coordinate and the inspector should show its
   * A/B details.
   */
  diffFocus:
    | { kind: 'stop'; canonicalId: string }
    | { kind: 'route'; canonicalId: string }
    | null;
  setDiffFocus: (f: AppState['diffFocus']) => void;
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
      if (mode !== 'diff') return { mode, diffFocus: null };
      if (s.feedOrder.length < 2) return { mode, compareFeedId: null, diffFocus: null };
      if (s.compareFeedId && s.compareFeedId !== s.activeFeedId) {
        return { mode, diffFocus: null };
      }
      const fallback = s.feedOrder.find((id) => id !== s.activeFeedId) ?? null;
      return { mode, compareFeedId: fallback, diffFocus: null };
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
      inspectorSelection: null,
    })),
  setCompareFeed: (id) =>
    set((s) => ({
      compareFeedId: id === s.activeFeedId ? null : id,
    })),
  inspectorSelection: null,
  setInspectorSelection: (selection) => set({ inspectorSelection: selection }),

  drawerOpen: false,
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),

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

  drawerTab: 'registry',
  setDrawerTab: (drawerTab) => set({ drawerTab }),

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
  diffFocus: null,
  setDiffFocus: (diffFocus) => set({ diffFocus }),
}));
