import { useAppStore } from '../state/app-store';
import { MODES, MODE_COLOR, MODE_LABEL } from '../gtfs/modes';
import { formatGtfsDate, stripYearSuffix, yearOfFeed } from '../timeline/math';
import DiffSidebar from '../diff/DiffSidebar';

export default function LeftPanel() {
  const mode = useAppStore((s) => s.mode);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const setActive = useAppStore((s) => s.setActiveFeed);
  const setCompare = useAppStore((s) => s.setCompareFeed);
  const removeFeed = useAppStore((s) => s.removeFeed);
  const setTimelineYear = useAppStore((s) => s.setTimelineYear);

  const pickActive = (id: string) => {
    setActive(id);
    if (mode === 'timeline') {
      const meta = feeds[id];
      if (meta) setTimelineYear(yearOfFeed(meta).year);
    }
  };

  const showStops = useAppStore((s) => s.showStops);
  const setShowStops = useAppStore((s) => s.setShowStops);
  const modeVisibility = useAppStore((s) => s.modeVisibility);
  const toggleModeVisibility = useAppStore((s) => s.toggleModeVisibility);

  return (
    <aside className="panel">
      <h3>Feeds</h3>
      {feedOrder.length === 0 && (
        <p className="muted">Load a GTFS zip to begin.</p>
      )}
      {feedOrder.map((id) => {
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
              <button
                title="Set as active"
                onClick={() => pickActive(id)}
                style={{ padding: '2px 6px', fontSize: 11 }}
              >
                {isActive ? 'A*' : 'A'}
              </button>
              {mode === 'diff' && (
                <button
                  title="Set as compare"
                  onClick={() => setCompare(isCompare ? null : id)}
                  disabled={isActive}
                  style={{
                    padding: '2px 6px',
                    fontSize: 11,
                    borderColor: isCompare ? 'var(--modified)' : undefined,
                    opacity: isActive ? 0.55 : 1,
                  }}
                >
                  {isCompare ? 'B*' : 'B'}
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

      <h3>Layers</h3>
      <label className="layer-toggle">
        <input
          type="checkbox"
          checked={showStops}
          onChange={(e) => setShowStops(e.target.checked)}
        />
        <span>Show stations</span>
      </label>

      <h3>Modes</h3>
      {MODES.map((m) => (
        <label key={m} className="layer-toggle">
          <input
            type="checkbox"
            checked={modeVisibility[m]}
            onChange={() => toggleModeVisibility(m)}
          />
          <span className="mode-swatch" style={{ background: MODE_COLOR[m] }} />
          <span>{MODE_LABEL[m]}</span>
        </label>
      ))}

      {mode === 'diff' ? (
        <DiffSidebar />
      ) : (
        <>
          <h3>Mode</h3>
        </>
      )}
    </aside>
  );
}
