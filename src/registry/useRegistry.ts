// Lightweight React hooks that bridge the imperative registry module into
// component state without re-implementing its storage in Zustand.

import { useEffect, useSyncExternalStore } from 'react';
import {
  getRegistry,
  isRegistryStale,
  rehydrateRegistryOnBoot,
  subscribeRegistry,
  type RegistrySnapshot,
} from './registry';
import { useAppStore } from '../state/app-store';

export function useRegistry(): RegistrySnapshot | null {
  useEffect(() => {
    rehydrateRegistryOnBoot();
  }, []);
  return useSyncExternalStore(subscribeRegistry, getRegistry, getRegistry);
}

export function useRegistryStale(): boolean {
  const snap = useRegistry();
  const feedOrder = useAppStore((s) => s.feedOrder);
  if (!snap) return feedOrder.length > 0;
  return isRegistryStale(feedOrder);
}
