import { useEffect, useState, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import TopBar from './app-shell/TopBar';
import LeftPanel from './app-shell/LeftPanel';
import RightPanel from './app-shell/RightPanel';
import { DiffMapArea } from './diff/DiffMapArea';
import TimelineStrip from './timeline/TimelineStrip';
import { DiffTimelineStrip } from './timeline/DiffTimelineStrip';
import { rehydrateOnBoot } from './gtfs/feed-loader';
import { rehydrateRegistryOnBoot } from './registry/registry';
import { useAppStore } from './state/app-store';
import './app-shell/layout.css';

const RIGHT_COLLAPSED = 24;
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

// Panel bounds scale down on narrower viewports so the center map area keeps
// a usable minimum instead of getting squeezed out by fixed 4K-tuned widths.
function panelBoundsForWidth(vw: number) {
  const leftWidth = Math.round(Math.max(200, Math.min(280, vw * 0.18)));
  const rightMin = Math.round(Math.max(180, Math.min(200, vw * 0.16)));
  const rightMax = Math.round(Math.max(rightMin, Math.min(600, vw * 0.32)));
  const rightDefault = Math.round(Math.max(rightMin, Math.min(320, vw * 0.22)));
  return { leftWidth, rightMin, rightMax, rightDefault };
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window === 'undefined' || window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

function DesktopOnlyNotice() {
  return (
    <div className="desktop-only-notice">
      <div className="desktop-only-notice-body">
        <h1>GiTFS works best on a larger screen</h1>
        <p>This app is designed for tablet and desktop use. Please switch to a bigger screen or rotate your device.</p>
      </div>
    </div>
  );
}

export default function App() {
  const isDesktop = useIsDesktop();
  const [bounds, setBounds] = useState(() =>
    panelBoundsForWidth(typeof window === 'undefined' ? 1920 : window.innerWidth)
  );
  const [rightWidth, setRightWidth] = useState(bounds.rightDefault);
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

  useEffect(() => {
    const onResize = () => {
      const next = panelBoundsForWidth(window.innerWidth);
      setBounds(next);
      setRightWidth((w) => Math.min(next.rightMax, Math.max(next.rightMin, w)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: rightWidth };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      setRightWidth(Math.min(bounds.rightMax, Math.max(bounds.rightMin, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rightWidth, bounds.rightMin, bounds.rightMax]);

  if (!isDesktop) {
    return <DesktopOnlyNotice />;
  }

  const colWidth = rightVisible ? rightWidth : RIGHT_COLLAPSED;

  return (
    <div className="app-root">
      <TopBar />
      <div className="app-body" style={{ gridTemplateColumns: `${bounds.leftWidth}px minmax(320px, 1fr) ${colWidth}px` }}>
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
