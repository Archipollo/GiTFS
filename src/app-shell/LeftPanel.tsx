import { useAppStore } from '../state/app-store';
import { MODES, MODE_COLOR, MODE_LABEL } from '../gtfs/modes';

export default function LeftPanel() {
  const mode = useAppStore((s) => s.mode);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const setActive = useAppStore((s) => s.setActiveFeed);
  const setCompare = useAppStore((s) => s.setCompareFeed);
  const removeFeed = useAppStore((s) => s.removeFeed);

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
        return (
          <div
            key={id}
            className={`feed-row ${isActive ? 'active' : ''}`}
            title={f.sourceName}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.label}
              </div>
              <div className="muted">
                {f.stopCount ?? '—'} stops · {f.routeCount ?? '—'} routes
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                title="Set as active"
                onClick={() => setActive(id)}
                style={{ padding: '2px 6px', fontSize: 11 }}
              >
                A
              </button>
              {mode === 'diff' && (
                <button
                  title="Set as compare"
                  onClick={() => setCompare(isCompare ? null : id)}
                  style={{
                    padding: '2px 6px',
                    fontSize: 11,
                    borderColor: isCompare ? 'var(--modified)' : undefined,
                  }}
                >
                  B
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
      <p className="muted" style={{ marginTop: 8 }}>
        Stations serving multiple modes stay visible until all their modes are hidden.
      </p>

      <h3>Mode</h3>
      <p className="muted">
        {mode === 'timeline' && 'Scrub between loaded feeds.'}
        {mode === 'diff' && 'Pick A (active) and B (compare) to see changes.'}
        {mode === 'scenario' && 'Scenario editing is not yet implemented.'}
      </p>
    </aside>
  );
}
