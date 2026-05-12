import { useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { useRegistry } from '../registry/useRegistry';
import type { PinnedEntity } from '../state/app-store';
import type { RawStop } from '../registry/stops-matcher';
import { stripYearSuffix, yearOfFeed } from './math';

export default function PinnedEntityView() {
  const pinnedEntities = useAppStore((s) => s.pinnedEntities);
  if (pinnedEntities.length === 0) return null;
  return (
    <>
      {pinnedEntities.map((pin) => (
        <PinnedEntityCard key={pin.canonicalId} pin={pin} />
      ))}
    </>
  );
}

function PinnedEntityCard({ pin }: { pin: PinnedEntity }) {
  const removePinnedEntity = useAppStore((s) => s.removePinnedEntity);
  const registryFocus = useAppStore((s) => s.registryFocus);
  const setFocus = useAppStore((s) => s.setRegistryFocus);
  const feeds = useAppStore((s) => s.feeds);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const registry = useRegistry();

  const rows = useMemo(() => {
    if (!registry || pin.kind !== 'stop') return [];
    const members = registry.stopMembers[pin.canonicalId] ?? [];
    const byFeed = new Map<string, RawStop>();
    for (const m of members) byFeed.set(m.feedId, m);
    return feedOrder.map((fid) => ({ feedId: fid, member: byFeed.get(fid) ?? null }));
  }, [pin, registry, feedOrder]);

  const canonical = pin.kind === 'stop' && registry ? registry.stops[pin.canonicalId] : null;

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
            📌 {pin.label}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
            {pin.canonicalId}
          </div>
        </div>
        <button
          onClick={() => {
            removePinnedEntity(pin.canonicalId);
            if (registryFocus?.canonicalId === pin.canonicalId) setFocus(null);
          }}
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
              canonicalId: pin.canonicalId,
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
