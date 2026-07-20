import { useAppStore } from '../state/app-store';
import { useDiff } from '../diff/useDiff';
import { LineListSidebar } from '../diff/LineListSidebar';

export default function LeftPanel() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const showStops = useAppStore((s) => s.showStops);
  const setShowStops = useAppStore((s) => s.setShowStops);
  const diff = useDiff(activeFeedId, compareFeedId);

  return (
    <aside className="panel">
      {diffOverviewLayout === 'timeline' && (
        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={showStops}
            onChange={(e) => setShowStops(e.target.checked)}
          />
          <span>Show stations</span>
        </label>
      )}
      {diff.kind === 'ready' ? (
        <LineListSidebar />
      ) : (
        <p className="muted">
          {diff.kind === 'idle' && 'Set A/B feeds above to compute a diff.'}
          {diff.kind === 'no-registry' && 'Build the entity registry above to compute a diff.'}
          {diff.kind === 'loading' && 'Computing diff…'}
          {diff.kind === 'error' && `Diff failed: ${diff.message}`}
        </p>
      )}
    </aside>
  );
}
