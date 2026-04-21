import { useAppStore } from '../state/app-store';

export default function RightPanel() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feed = useAppStore((s) => (activeFeedId ? s.feeds[activeFeedId] : null));

  return (
    <aside className="panel right">
      <h3>Inspector</h3>
      {!feed && <p className="muted">No feed selected.</p>}
      {feed && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{feed.label}</div>
          <div className="muted">Source: {feed.sourceName}</div>
          <div className="muted">
            Loaded {new Date(feed.loadedAt).toLocaleString()}
          </div>
          <table style={{ marginTop: 12, width: '100%', fontSize: 13 }}>
            <tbody>
              <tr><td className="muted">Stops</td><td>{feed.stopCount ?? '—'}</td></tr>
              <tr><td className="muted">Routes</td><td>{feed.routeCount ?? '—'}</td></tr>
              <tr><td className="muted">Trips</td><td>{feed.tripCount ?? '—'}</td></tr>
              <tr><td className="muted">Valid from</td><td>{feed.feedStartDate ?? '—'}</td></tr>
              <tr><td className="muted">Valid to</td><td>{feed.feedEndDate ?? '—'}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 16 }}>
            Click a stop or route on the map to see attributes here.
          </p>
        </>
      )}
    </aside>
  );
}
