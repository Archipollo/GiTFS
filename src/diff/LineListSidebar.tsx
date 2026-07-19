// Searchable, filterable route list — the "line view" for diff mode.
// Replaces the old per-route-status checkbox drawer: instead of toggling
// map visibility per identity-status, this list is the primary way to pick
// a route to inspect, driving `diffRouteFocus` + `diffViewMode`.

import { useMemo, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import { useDiffedShapes } from './useDiffedShapes';
import { deriveLineListRows, type LineListRow, type LineListStatus } from './route-list';
import { SEGMENT_COLOR } from '../gtfs/segment-graph';
import { ModeSwatch } from '../inspector/components';

const FILTERS: Array<{ id: LineListStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'added', label: 'Added' },
  { id: 'removed', label: 'Removed' },
  { id: 'rerouted', label: 'Rerouted' },
  { id: 'unchanged', label: 'Unchanged' },
];

const STATUS_BADGE: Record<LineListStatus, { bg: string; fg: string; label: string }> = {
  added: { bg: SEGMENT_COLOR.added, fg: '#ffffff', label: 'Added' },
  removed: { bg: SEGMENT_COLOR.removed, fg: '#ffffff', label: 'Removed' },
  rerouted: { bg: SEGMENT_COLOR.changed, fg: '#4a3b00', label: 'Rerouted' },
  unchanged: { bg: SEGMENT_COLOR.unchanged, fg: '#ffffff', label: 'Unchanged' },
};

function matchesSearch(row: LineListRow, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${row.shortName} ${row.longName}`.toLowerCase();
  return haystack.includes(needle);
}

export function LineListSidebar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffViewMode = useAppStore((s) => s.setDiffViewMode);

  const diffStatus = useDiff(activeFeedId, compareFeedId);
  const diffedShapes = useDiffedShapes(diffStatus);
  const routesWithGeomChange = useAppStore((s) => s.diffRoutesWithGeomChange);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LineListStatus | 'all'>('all');

  const rows = useMemo(() => {
    if (diffStatus.kind !== 'ready') return [];
    return deriveLineListRows(diffStatus.result.routes, routesWithGeomChange);
  }, [diffStatus, routesWithGeomChange]);

  const needle = search.trim().toLowerCase();
  const filteredRows = rows.filter(
    (r) => (filter === 'all' || r.status === filter) && matchesSearch(r, needle),
  );

  if (diffStatus.kind !== 'ready') return null;

  const handleRowClick = (row: LineListRow) => {
    setDiffRouteFocus(row.canonicalId, [row.canonicalId], null);
    setDiffViewMode('detail');
  };

  return (
    <div className="line-list-sidebar">
      <input
        type="text"
        className="line-list-search"
        placeholder="Search routes..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="line-list-filter-chips">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`line-list-chip${filter === id ? ' on' : ' off'}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="line-list-rows" aria-busy={!diffedShapes}>
        {filteredRows.length === 0 && (
          <p className="muted" style={{ padding: '8px 6px' }}>No lines match.</p>
        )}
        {filteredRows.map((row) => (
          <button
            key={row.canonicalId}
            type="button"
            className={`line-list-row${row.canonicalId === diffRouteFocus ? ' selected' : ''}`}
            onClick={() => handleRowClick(row)}
          >
            <ModeSwatch mode={row.mode} />
            <span className="line-list-row-short">{row.shortName || '—'}</span>
            <span className="line-list-row-long">{row.longName}</span>
            <span
              className="line-list-row-badge"
              style={{ background: STATUS_BADGE[row.status].bg, color: STATUS_BADGE[row.status].fg }}
            >
              {STATUS_BADGE[row.status].label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
