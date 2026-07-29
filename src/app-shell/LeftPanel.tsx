import { useAppStore } from '../state/app-store';
import { useDiff } from '../diff/useDiff';
import { LineListSidebar } from '../diff/LineListSidebar';

export default function LeftPanel() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const isTimeline = diffOverviewLayout === 'timeline';
  const feedA = feedASelection;
  const feedB = isTimeline ? activeFeedId : compareFeedId;
  // At the baseline year itself feedA === feedB — nothing to compare yet, but
  // the list should still show the baseline's own lines (see LineListSidebar).
  const isBaselineView = isTimeline && !!feedA && feedA === feedB;
  const diff = useDiff(feedA, feedB, isBaselineView);

  return (
    <aside className="panel">
      {diff.kind === 'ready' ? (
        <LineListSidebar />
      ) : (
        <p className="muted">
          {diff.kind === 'idle' && (isTimeline
            ? 'Scrub to a year after the baseline to list lines.'
            : 'Set A/B feeds above to compute a diff.')}
          {diff.kind === 'no-registry' && 'Build the entity registry above to compute a diff.'}
          {diff.kind === 'loading' && 'Computing diff…'}
          {diff.kind === 'error' && `Diff failed: ${diff.message}`}
        </p>
      )}
    </aside>
  );
}
