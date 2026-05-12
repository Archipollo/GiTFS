import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect } from 'react';
import { useAppStore } from '../state/app-store';
import PinnedEntityView from '../timeline/PinnedEntityView';
import DiffInspector from '../diff/DiffInspector';
import StopCard from '../inspector/StopCard';
import RouteCard from '../inspector/RouteCard';
import { SegmentCard } from '../inspector/SegmentCard';
import { formatGtfsDate, stripYearSuffix, yearOfFeed } from '../timeline/math';

interface RightPanelProps {
  visible: boolean;
  onToggle: () => void;
  onResizeStart: (e: ReactMouseEvent) => void;
}

export default function RightPanel({ visible, onToggle, onResizeStart }: RightPanelProps) {
  const mode = useAppStore((s) => s.mode);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feed = useAppStore((s) => (activeFeedId ? s.feeds[activeFeedId] : null));
  const stop = useAppStore((s) => s.inspectorStop);
  const route = useAppStore((s) => s.inspectorRoute);
  const segment = useAppStore((s) => s.inspectorSegment);
  const hasPinned = useAppStore((s) => s.pinnedEntities.length > 0);

  useEffect(() => {
    if (!visible && (stop || route || segment)) onToggle();
  }, [visible, stop, route, segment, onToggle]);

  return (
    <aside className={`panel right right-panel${visible ? '' : ' right-panel--collapsed'}`}>
      <div className="right-panel-resize-handle" onMouseDown={onResizeStart} />
      <button
        className="right-panel-toggle"
        onClick={onToggle}
        title={visible ? 'Hide inspector' : 'Show inspector'}
        aria-label={visible ? 'Hide inspector' : 'Show inspector'}
        aria-expanded={visible}
      >
        {visible ? '›' : '‹'}
      </button>

      {visible && (
        <div className="right-panel-content">
          {mode === 'diff' ? (
            <DiffInspector />
          ) : (
            <>
              <h3>Inspector</h3>
              {hasPinned && <PinnedEntityView />}
              {stop && <StopCard />}
              {segment && <SegmentCard />}
              {route && <RouteCard />}
              {!stop && !segment && !route && !hasPinned && feed && <FeedSummary />}
              {!feed && !hasPinned && <p className="muted">No feed selected.</p>}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function FeedSummary() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feed = useAppStore((s) => (activeFeedId ? s.feeds[activeFeedId] : null));
  if (!feed) return null;
  const fy = yearOfFeed(feed);
  const start = formatGtfsDate(feed.feedStartDate);
  const end = formatGtfsDate(feed.feedEndDate);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span
          className={`feed-year${fy.synthetic ? ' feed-year--synthetic' : ''}`}
          title={fy.synthetic ? 'Year inferred from ingest time' : undefined}
        >
          {fy.year}
          {fy.synthetic ? '?' : ''}
        </span>
        <span
          style={{
            fontWeight: 600,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {stripYearSuffix(feed.label)}
        </span>
      </div>
      <div className="muted">Source: {feed.sourceName}</div>
      <div className="muted">
        Loaded {new Date(feed.loadedAt).toLocaleString()}
      </div>
      <table style={{ marginTop: 12, width: '100%', fontSize: 13 }}>
        <tbody>
          <tr>
            <td className="muted">Year</td>
            <td title={fy.synthetic ? 'Inferred from ingest time' : 'Midpoint of validity span'}>
              {fy.year}
              {fy.synthetic ? ' (inferred)' : ''}
            </td>
          </tr>
          <tr><td className="muted">Stops</td><td>{feed.stopCount ?? '—'}</td></tr>
          <tr><td className="muted">Routes</td><td>{feed.routeCount ?? '—'}</td></tr>
          <tr><td className="muted">Trips</td><td>{feed.tripCount ?? '—'}</td></tr>
          <tr><td className="muted">Valid from</td><td>{start ?? feed.feedStartDate ?? '—'}</td></tr>
          <tr><td className="muted">Valid to</td><td>{end ?? feed.feedEndDate ?? '—'}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
