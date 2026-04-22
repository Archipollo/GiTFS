import { useAppStore } from '../state/app-store';
import { useRegistry } from '../registry/useRegistry';
import PinnedEntityView from '../timeline/PinnedEntityView';
import DiffInspector from '../diff/DiffInspector';
import { formatGtfsDate, stripYearSuffix, yearOfFeed } from '../timeline/math';

export default function RightPanel() {
  const mode = useAppStore((s) => s.mode);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feed = useAppStore((s) => (activeFeedId ? s.feeds[activeFeedId] : null));
  const selection = useAppStore((s) => s.inspectorSelection);
  const setDrawerTab = useAppStore((s) => s.setDrawerTab);
  const setRegistryFocus = useAppStore((s) => s.setRegistryFocus);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const pinnedEntity = useAppStore((s) => s.pinnedEntity);
  const setPinnedEntity = useAppStore((s) => s.setPinnedEntity);
  const registry = useRegistry();

  const canonicalId =
    selection?.kind === 'stop' && selection.canonicalId
      ? selection.canonicalId
      : null;
  const canonical = canonicalId && registry ? registry.stops[canonicalId] : null;
  const canonicalMembers =
    canonicalId && registry ? registry.stopMembers[canonicalId] ?? [] : [];

  const isPinned = pinnedEntity && canonical && pinnedEntity.canonicalId === canonical.canonicalId;

  if (mode === 'diff') {
    return (
      <aside className="panel right">
        <DiffInspector />
      </aside>
    );
  }

  return (
    <aside className="panel right">
      <h3>Inspector</h3>
      {pinnedEntity && <PinnedEntityView />}
      {!feed && !pinnedEntity && <p className="muted">No feed selected.</p>}
      {feed && (() => {
        const fy = yearOfFeed(feed);
        const start = formatGtfsDate(feed.feedStartDate);
        const end = formatGtfsDate(feed.feedEndDate);
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span
                className={`feed-year${fy.synthetic ? ' feed-year--synthetic' : ''}`}
                title={fy.synthetic ? 'Year inferred from ingest time' : undefined}
              >
                {fy.year}
                {fy.synthetic ? '?' : ''}
              </span>
              <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
          {!selection && (
            <p className="muted" style={{ marginTop: 16 }}>
              Click a stop or route on the map to see attributes here.
            </p>
          )}
          {selection && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {selection.kind === 'stop' ? (
                <>
                  <div style={{ fontWeight: 600 }}>Station</div>
                  <div>{selection.stopName || '(unnamed stop)'}</div>
                  <div className="muted">ID: {selection.stopId || '—'}</div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600 }}>Line Geometry</div>
                  <div className="muted">Shape ID: {selection.shapeId || '—'}</div>
                </>
              )}
              <div className="muted">
                Modes: {selection.modes.length ? selection.modes.join(', ') : 'other'}
              </div>
              {selection.kind === 'stop' && (
                <div style={{ marginTop: 10, fontSize: 12 }}>
                  <div className="muted" style={{ textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    Canonical entity
                  </div>
                  {!registry && <div className="muted">Registry not built yet.</div>}
                  {registry && !canonical && (
                    <div className="muted">No canonical match (rebuild the registry?).</div>
                  )}
                  {canonical && (
                    <>
                      <div style={{ fontFamily: 'ui-monospace, monospace' }}>
                        {canonical.canonicalId}
                      </div>
                      <div className="muted">
                        {canonical.memberCount} members across {canonical.feedCount} feed{canonical.feedCount === 1 ? '' : 's'}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <button
                          style={{ padding: '4px 8px', fontSize: 11 }}
                          onClick={() => {
                            if (isPinned) {
                              setPinnedEntity(null);
                            } else {
                              setPinnedEntity({
                                kind: 'stop',
                                canonicalId: canonical.canonicalId,
                                label: canonical.name,
                              });
                            }
                          }}
                          title="Pin this entity so the timeline slider drives its history"
                        >
                          {isPinned ? 'Unpin' : 'Pin to timeline'}
                        </button>
                        <button
                          style={{ padding: '4px 8px', fontSize: 11 }}
                          onClick={() => {
                            setRegistryFocus({
                              kind: 'stop',
                              canonicalId: canonical.canonicalId,
                              lat: canonical.lat,
                              lon: canonical.lon,
                            });
                            setDrawerTab('registry');
                            if (!drawerOpen) toggleDrawer();
                          }}
                        >
                          Open in registry ({canonicalMembers.length})
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
        );
      })()}
    </aside>
  );
}
