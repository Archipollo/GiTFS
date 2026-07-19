import { useEffect, useState, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import TopBar from './app-shell/TopBar';
import DiffControlBar from './app-shell/DiffControlBar';
import LeftPanel from './app-shell/LeftPanel';
import RightPanel from './app-shell/RightPanel';
import { DiffMapArea } from './diff/DiffMapArea';
import TimelineStrip from './timeline/TimelineStrip';
import { DiffTimelineStrip } from './timeline/DiffTimelineStrip';
import { rehydrateOnBoot } from './gtfs/feed-loader';
import { rehydrateRegistryOnBoot } from './registry/registry';
import { useAppStore } from './state/app-store';
import './app-shell/layout.css';

const RIGHT_MIN = 200;
const RIGHT_MAX = 600;
const RIGHT_DEFAULT = 320;
const RIGHT_COLLAPSED = 24;

export default function App() {
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [rightVisible, setRightVisible] = useState(true);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const autoPairDiffFeeds = useAppStore((s) => s.autoPairDiffFeeds);

  useEffect(() => {
    (async () => {
      await rehydrateOnBoot();
      rehydrateRegistryOnBoot();
      autoPairDiffFeeds();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: rightWidth };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  const colWidth = rightVisible ? rightWidth : RIGHT_COLLAPSED;

  return (
    <div className="app-root app-root--diff-controls">
      <TopBar />
      <DiffControlBar />
      <div className="app-body" style={{ gridTemplateColumns: `280px 1fr ${colWidth}px` }}>
        <LeftPanel />
        <main className="app-map">
          <DiffMapArea />
          <TimelineStrip />
          <DiffTimelineStrip />
        </main>
        <RightPanel
          visible={rightVisible}
          onToggle={() => setRightVisible((v) => !v)}
          onResizeStart={handleResizeStart}
        />
      </div>
    </div>
  );
}
