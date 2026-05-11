import { useAppStore } from '../state/app-store';
import { buildRegistry } from './registry';

/**
 * Shared hook that encapsulates the registry build flow:
 * progress reporting, error handling, and cleanup.
 *
 * Returns the `handleBuild` trigger and a `building` flag derived
 * from `registryProgress`.
 */
export function useBuildRegistry() {
  const feeds = useAppStore((s) => s.feeds);
  const registryProgress = useAppStore((s) => s.registryProgress);
  const setRegistryProgress = useAppStore((s) => s.setRegistryProgress);

  const building = !!registryProgress;

  const handleBuild = async () => {
    setRegistryProgress({ stage: 'Starting', step: 0, total: 1 });
    try {
      await buildRegistry((p) => {
        setRegistryProgress({
          stage: p.stage,
          step: p.step,
          total: p.total,
          feedLabel: p.feedId ? feeds[p.feedId]?.label : undefined,
        });
      });
    } catch (err) {
      console.error('registry build failed', err);
      alert(`Registry build failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRegistryProgress(null);
    }
  };

  return { handleBuild, building, registryProgress };
}
