import { create } from 'zustand';
import { MODES, type Mode } from '../gtfs/modes';
import { removeFeedFromOPFS } from '../gtfs/opfs';

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

interface AppState {
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
}

export function selectMapBusy(s: AppState): boolean {
  if (s.ingesting) return true;
  return Object.keys(s.mapTasks).length > 0;
}

export function selectMapBusyLabel(s: AppState): string {
  if (s.ingesting) return s.ingesting.progress;
  const keys = Object.keys(s.mapTasks);
  if (keys.length === 0) return '';
  return s.mapTasks[keys[keys.length - 1]];
}

export const useAppStore = create<AppState>((set) => ({
  mode: 'timeline',
  setMode: (mode) => set({ mode }),

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
  setActiveFeed: (id) => set({ activeFeedId: id }),
  setCompareFeed: (id) => set({ compareFeedId: id }),

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
}));
