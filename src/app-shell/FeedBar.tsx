import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/app-store';
import { formatGtfsDate, stripYearSuffix, yearOfFeed } from '../timeline/math';

export default function FeedBar() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const setActive = useAppStore((s) => s.setActiveFeed);
  const removeFeed = useAppStore((s) => s.removeFeed);
  const setTimelineFeedId = useAppStore((s) => s.setTimelineFeedId);
  const open = useAppStore((s) => s.feedBarOpen);
  const setOpen = useAppStore((s) => s.setFeedBarOpen);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  const pickActive = (id: string) => {
    setActive(id);
    if (diffOverviewLayout === 'timeline') setTimelineFeedId(id);
  };

  const sortedFeedOrder = [...feedOrder].sort(
    (a, b) => yearOfFeed(feeds[a]).year - yearOfFeed(feeds[b]).year,
  );

  return (
    <div className="upload-menu" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Feeds ({feedOrder.length}) ▾
      </button>
      {open && (
        <div className="upload-menu-popover" role="menu">
          {feedOrder.length === 0 && <p className="muted">Load a GTFS zip to begin.</p>}
          {sortedFeedOrder.map((id) => {
            const f = feeds[id];
            const isActive = id === activeFeedId;
            const isCompare = id === compareFeedId;
            const fy = yearOfFeed(f);
            const displayName = stripYearSuffix(f.label);
            const start = formatGtfsDate(f.feedStartDate);
            const end = formatGtfsDate(f.feedEndDate);
            const validity = start && end ? `${start} → ${end}` : start ?? end ?? '';
            const rowTooltip = [
              f.sourceName,
              validity ? `Validity: ${validity}` : null,
              fy.synthetic ? 'Year inferred from ingest time' : null,
            ]
              .filter(Boolean)
              .join('\n');
            return (
              <div
                key={id}
                className={`feed-row ${isActive ? 'active' : ''} ${isCompare ? 'compare' : ''}`}
                title={rowTooltip}
              >
                <span
                  className={`feed-year${fy.synthetic ? ' feed-year--synthetic' : ''}`}
                  title={
                    fy.synthetic
                      ? 'Inferred from ingest time — no feed_info/calendar dates available'
                      : validity
                        ? `Validity: ${validity}`
                        : undefined
                  }
                >
                  {fy.year}
                  {fy.synthetic ? '?' : ''}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayName}
                  </div>
                  <div className="muted">
                    {f.stopCount ?? '—'} stops · {f.routeCount ?? '—'} routes
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {diffOverviewLayout === 'timeline' && (
                    <button
                      title="Set as active"
                      onClick={() => pickActive(id)}
                      style={{ padding: '2px 6px', fontSize: 11 }}
                    >
                      {isActive ? 'A*' : 'A'}
                    </button>
                  )}
                  <button
                    title="Remove"
                    onClick={() => removeFeed(id)}
                    style={{ padding: '2px 6px', fontSize: 11 }}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
