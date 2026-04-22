import { useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { useRegistry } from '../registry/useRegistry';
import type { RawStop } from '../registry/stops-matcher';
import { stripYearSuffix, yearOfFeed } from './math';

/**
 * Right-panel card that renders a pinned canonical entity's per-feed history.
 * The currently-active feed (driven by the timeline slider) is visually flagged
 * so the user can see which year the map is currently displaying.
 */
export default function PinnedEntityView() {
  const pinned = useAppStore((s) => s.pinnedEntity);
  const setPinned = useAppStore((s) => s.setPinnedEntity);
  const setFocus = useAppStore((s) => s.setRegistryFocus);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const registry = useRegistry();

  const rows = useMemo(() => {
    if (!pinned || !registry) return [];
    if (pinned.kind !== 'stop') return [];
    const members = registry.stopMembers[pinned.canonicalId] ?? [];
    const byFeed = new Map<string, RawStop>();
    for (const m of members) byFeed.set(m.feedId, m);
    return feedOrder.map((fid) => ({ feedId: fid, member: byFeed.get(fid) ?? null }));
  }, [pinned, registry, feedOrder]);

  if (!pinned) return null;

  const canonical =
    pinned.kind === 'stop' && registry ? registry.stops[pinned.canonicalId] : null;

  // Detect attribute drift across feeds for compact annotation.
  const nameSet = new Set<string>();
  const coordSet = new Set<string>();
  for (const r of rows) {
    if (!r.member) continue;
    nameSet.add(r.member.name || '');
    coordSet.add(`${r.member.lat.toFixed(5)},${r.member.lon.toFixed(5)}`);
  }
  const presentCount = rows.filter((r) => r.member).length;

  return (
    <div className="pinned-card">
      <div className="pinned-head">
        <div>
          <div className="pinned-chip" title="Pinned entity — the timeline slider drives this history">
            📌 {pinned.label}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
            {pinned.canonicalId}
          </div>
        </div>
        <button
          onClick={() => setPinned(null)}
          style={{ padding: '2px 8px', fontSize: 11 }}
          title="Unpin"
        >
          ×
        </button>
      </div>

      {canonical && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {presentCount}/{feedOrder.length} feeds · {nameSet.size} distinct name{nameSet.size === 1 ? '' : 's'} ·{' '}
          {coordSet.size} distinct location{coordSet.size === 1 ? '' : 's'}
          <button
            style={{ padding: '2px 6px', fontSize: 11, marginLeft: 6 }}
            onClick={() => setFocus({
              kind: 'stop',
              canonicalId: pinned.canonicalId,
              lat: canonical.lat,
              lon: canonical.lon,
            })}
            title="Center the map on this entity"
          >
            Focus
          </button>
        </div>
      )}

      <table className="pinned-table">
        <thead>
          <tr><th>Year</th><th>Feed</th><th>Present</th><th>Name</th><th>Lat / Lon</th></tr>
        </thead>
        <tbody>
          {rows.map(({ feedId, member }) => {
            const meta = feeds[feedId];
            const fy = meta ? yearOfFeed(meta) : null;
            const name = meta ? stripYearSuffix(meta.label) : feedId;
            const isActive = feedId === activeFeedId;
            return (
              <tr key={feedId} className={isActive ? 'active' : ''}>
                <td
                  style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
                  title={fy?.synthetic ? 'Year inferred from ingest time' : undefined}
                >
                  {fy ? `${fy.year}${fy.synthetic ? '?' : ''}` : '—'}
                </td>
                <td>
                  {isActive && <span className="pinned-dot" title="Currently displayed" />}
                  {name}
                </td>
                <td>{member ? '●' : <span className="muted">—</span>}</td>
                <td>{member?.name ?? <span className="muted">absent</span>}</td>
                <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                  {member ? `${member.lat.toFixed(5)}, ${member.lon.toFixed(5)}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
