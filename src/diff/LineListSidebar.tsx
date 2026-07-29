// Searchable, filterable route list — the "line view" for diff mode.
// Replaces the old per-route-status checkbox drawer: instead of toggling
// map visibility per identity-status, this list is the primary way to pick
// a route to inspect, driving `diffRouteFocus` + `diffViewMode`. Each row
// with more than one isolable direction expands to per-direction sub-rows so
// the map diff can be scoped to a single direction (see `diffDirectionFocus`).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import { useDiffedShapes } from './useDiffedShapes';
import { useLineDirections } from './useLineDirections';
import { deriveLineListRows, type LineListRow, type LineListStatus } from './route-list';
import { SEGMENT_COLOR } from '../gtfs/segment-graph';
import { ModeSwatch } from '../inspector/components';
import type { RouteDiffEntry } from './engine';

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

interface LineRowProps {
  row: LineListRow;
  entry: RouteDiffEntry | null;
  feedA: string | null;
  feedB: string | null;
  isolableDirections: number[];
  selected: boolean;
  expanded: boolean;
  directionFocus: number | null;
  showStatus: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onSelectDirection: (dir: number | null) => void;
  rowRef: (el: HTMLDivElement | null) => void;
}

function LineRow({
  row, entry, feedA, feedB, isolableDirections,
  selected, expanded, directionFocus, showStatus,
  onSelect, onToggleExpand, onSelectDirection, rowRef,
}: LineRowProps) {
  const hasDirections = isolableDirections.length > 0;
  // Only fetch headsigns once the row is actually opened.
  const { headsigns } = useLineDirections(entry, feedA, feedB, expanded && hasDirections);
  const badge = STATUS_BADGE[row.status];

  return (
    <div ref={rowRef} className={`line-list-item${selected ? ' selected' : ''}`}>
      <div className="line-list-row-main">
        <button
          type="button"
          className={`line-list-row${selected ? ' selected' : ''}`}
          onClick={onSelect}
        >
          <ModeSwatch mode={row.mode} />
          <span className="line-list-row-short">{row.shortName || '—'}</span>
          <span className="line-list-row-long">{row.longName}</span>
          {showStatus && (
            <span className="line-list-row-badge" style={{ background: badge.bg, color: badge.fg }}>
              {badge.label}
            </span>
          )}
        </button>
        {hasDirections && (
          <button
            type="button"
            className="line-list-expand"
            aria-label={expanded ? 'Collapse directions' : 'Show directions'}
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>
      {expanded && hasDirections && (
        <div className="line-list-subrows">
          <button
            type="button"
            className={`line-list-subrow${selected && directionFocus == null ? ' selected' : ''}`}
            onClick={() => onSelectDirection(null)}
          >
            <span className="line-list-subrow-dir">Entire line</span>
          </button>
          {isolableDirections.map((id) => (
            <button
              key={id}
              type="button"
              className={`line-list-subrow${selected && directionFocus === id ? ' selected' : ''}`}
              onClick={() => onSelectDirection(id)}
            >
              <span className="line-list-subrow-dir">Dir {id}</span>
              <span className="line-list-subrow-headsign">{headsigns.get(id) || '—'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LineListSidebar() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const diffRouteFocus = useAppStore((s) => s.diffRouteFocus);
  const diffDirectionFocus = useAppStore((s) => s.diffDirectionFocus);
  const setDiffRouteFocus = useAppStore((s) => s.setDiffRouteFocus);
  const setDiffDirectionFocus = useAppStore((s) => s.setDiffDirectionFocus);
  const setDiffViewMode = useAppStore((s) => s.setDiffViewMode);
  const diffRouteDirections = useAppStore((s) => s.diffRouteDirections);

  // In Timeline mode the list follows the "since baseline" pairing (matching
  // the narrative panel), not the free-standing A/B diff slots — those hold
  // whatever the auto-pair last picked and can coincide with the currently
  // scrubbed year (e.g. scrubbing to the newest feed), which would otherwise
  // silently collapse the list to idle.
  const isTimeline = diffOverviewLayout === 'timeline';
  const feedA = feedASelection;
  const feedB = isTimeline ? activeFeedId : compareFeedId;

  // Scrubbed to the baseline year itself: there's nothing to compare against
  // yet, but the list should still show the baseline's own lines (as the
  // "status quo") rather than going blank. Self-diffing baseline-vs-baseline
  // trivially yields "unchanged" for every line, which the UI below hides.
  const isBaselineView = isTimeline && !!feedA && feedA === feedB;

  const diffStatus = useDiff(feedA, feedB, isBaselineView);
  const diffedShapes = useDiffedShapes(diffStatus);
  const routesWithGeomChange = useAppStore((s) => s.diffRoutesWithGeomChange);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LineListStatus | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rowElsRef = useRef(new Map<string, HTMLDivElement>());

  // A route focused from outside this list (clicking a line on the map) still
  // needs its row uncollapsed and scrolled into view — clicking inside the
  // list already does both via `handleRowClick`, but a map click only ever
  // updates the shared `diffRouteFocus` store value, so this list otherwise
  // has no way to react to it. Uncollapse only: never touch direction focus.
  useEffect(() => {
    if (!diffRouteFocus) return;
    setExpandedId(diffRouteFocus);
    rowElsRef.current.get(diffRouteFocus)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [diffRouteFocus]);

  const rows = useMemo(() => {
    if (diffStatus.kind !== 'ready') return [];
    return deriveLineListRows(diffStatus.result.routes, routesWithGeomChange);
  }, [diffStatus, routesWithGeomChange]);

  const entriesByCid = useMemo(() => {
    const m = new Map<string, RouteDiffEntry>();
    if (diffStatus.kind === 'ready') {
      for (const e of diffStatus.result.routes) m.set(e.canonicalId, e);
    }
    return m;
  }, [diffStatus]);

  const needle = search.trim().toLowerCase();
  // Status filters don't apply to the baseline's own line list — every row
  // trivially self-diffs to "unchanged", so a status chip would just hide
  // everything except "Unchanged".
  const filteredRows = rows.filter(
    (r) => (isBaselineView || filter === 'all' || r.status === filter) && matchesSearch(r, needle),
  );

  if (diffStatus.kind !== 'ready') return null;

  // Clicking a row: focus the whole line, open its detail view, and expand it
  // to reveal its directions (matches "uncollapse after clicking").
  const handleRowClick = (cid: string) => {
    setDiffRouteFocus(cid, [cid], null);
    setDiffViewMode('detail');
    setExpandedId(cid);
  };

  const handleSelectDirection = (cid: string, dir: number | null) => {
    setDiffRouteFocus(cid, [cid], null); // resets direction to null…
    setDiffDirectionFocus(dir); // …then apply the chosen one
    setDiffViewMode('detail');
    setExpandedId(cid);
  };

  return (
    <div className="line-list-sidebar">
      <input
        type="text"
        className="line-list-search"
        placeholder="Search lines..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!isBaselineView && (
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
      )}
      <div className="line-list-rows" aria-busy={!diffedShapes}>
        {filteredRows.length === 0 && (
          <p className="muted" style={{ padding: '8px 6px' }}>No lines match.</p>
        )}
        {filteredRows.map((row) => (
          <LineRow
            key={row.canonicalId}
            row={row}
            entry={entriesByCid.get(row.canonicalId) ?? null}
            feedA={feedA}
            feedB={feedB}
            isolableDirections={diffRouteDirections?.get(row.canonicalId) ?? []}
            selected={row.canonicalId === diffRouteFocus}
            expanded={expandedId === row.canonicalId}
            directionFocus={diffDirectionFocus}
            showStatus={!isBaselineView}
            onSelect={() => handleRowClick(row.canonicalId)}
            onToggleExpand={() =>
              setExpandedId((cur) => (cur === row.canonicalId ? null : row.canonicalId))
            }
            onSelectDirection={(dir) => handleSelectDirection(row.canonicalId, dir)}
            rowRef={(el) => {
              if (el) rowElsRef.current.set(row.canonicalId, el);
              else rowElsRef.current.delete(row.canonicalId);
            }}
          />
        ))}
      </div>
    </div>
  );
}
