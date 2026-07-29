import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect } from 'react';
import { useAppStore } from '../state/app-store';
import PinnedEntityView from '../timeline/PinnedEntityView';
import { TimelineChangePanel } from '../timeline/TimelineChangePanel';
import DiffInspector from '../diff/DiffInspector';
import StopCard from '../inspector/StopCard';
import RouteCard from '../inspector/RouteCard';
import { SegmentCard } from '../inspector/SegmentCard';

interface RightPanelProps {
  visible: boolean;
  onToggle: () => void;
  onResizeStart: (e: ReactMouseEvent) => void;
}

export default function RightPanel({ visible, onToggle, onResizeStart }: RightPanelProps) {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
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
          {diffOverviewLayout !== 'timeline' ? (
            <DiffInspector />
          ) : (
            <>
              <TimelineChangePanel />
              <h3>Inspector</h3>
              {hasPinned && <PinnedEntityView />}
              {stop && <StopCard />}
              {segment && <SegmentCard />}
              {route && <RouteCard />}
              {!stop && !segment && !route && !hasPinned && (
                <p className="muted">Select a stop, line, or segment.</p>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
