// Shared presentational bits for the inspector panels.
//
// Both timeline and diff mode render the same "line pill" + "stop pill"
// lists. Mode-specific wrappers (see `StopCard.tsx`, `RouteCard.tsx`,
// `diff/DiffInspector.tsx`) compose these primitives.

import { useState } from 'react';
import { MODE_COLOR, MODE_LABEL, type Mode } from '../gtfs/modes';
import { DIFF_COLOR } from '../diff/geojson';
import type { LineForStop } from '../gtfs/queries';

/** Mode swatch used on line chips. */
export function ModeSwatch({ mode, size = 10 }: { mode: Mode; size?: number }) {
  return (
    <span
      className="mode-swatch"
      style={{
        background: MODE_COLOR[mode],
        width: size,
        height: size,
        borderRadius: 3,
      }}
      title={MODE_LABEL[mode]}
    />
  );
}

/** Small status chip for diff-aware lists (added / removed / modified / …). */
export function DiffStatusDot({ status }: { status: string | null }) {
  if (!status) return null;
  const color = DIFF_COLOR[status as keyof typeof DIFF_COLOR] ?? '#94a3b8';
  return (
    <span
      className="line-status-dot"
      style={{ background: color }}
      title={status}
    />
  );
}

export interface LinePillProps {
  line: Pick<LineForStop, 'route_short_name' | 'route_long_name' | 'mode' | 'trip_count'> & {
    agency_name?: string;
  };
  /** Optional secondary info tagged per diff side (e.g. "removed"). */
  status?: string | null;
  /** Highlight as the currently-selected line. */
  selected?: boolean;
  onClick?: () => void;
}

/**
 * Compact clickable chip listing a line served by a stop. Designed so many
 * of them stack vertically in a tight 300-ish-pixel inspector column.
 */
export function LinePill({ line, status, selected, onClick }: LinePillProps) {
  const short = line.route_short_name || '—';
  const title = line.route_long_name || line.agency_name || '';
  return (
    <button
      type="button"
      className={`line-pill${selected ? ' selected' : ''}${status ? ` line-pill--${status}` : ''}`}
      onClick={onClick}
      title={title ? `${title}${line.agency_name ? ` · ${line.agency_name}` : ''}` : line.agency_name || undefined}
    >
      <ModeSwatch mode={line.mode} />
      <span className="line-pill-short">{short}</span>
      {line.route_long_name && (
        <span className="line-pill-long">{line.route_long_name}</span>
      )}
      {line.trip_count > 0 && (
        <span className="line-pill-n" title={`${line.trip_count} trips call here`}>
          {line.trip_count}
        </span>
      )}
      <DiffStatusDot status={status ?? null} />
    </button>
  );
}

export interface StopPillProps {
  stopId: string;
  stopName: string;
  status?: string | null;
  selected?: boolean;
  /** 1-based sequence number shown as a badge at the start of the pill. */
  seq?: number | null;
  onClick?: () => void;
}

/**
 * Compact clickable chip listing a stop along a route. Optionally renders a
 * leading sequence number when the stop is part of an ordered list. The raw
 * stop id is available on hover via `title` rather than taking up row width.
 */
export function StopPill({
  stopId,
  stopName,
  status,
  selected,
  seq,
  onClick,
}: StopPillProps) {
  return (
    <button
      type="button"
      className={[
        'stop-pill',
        seq != null ? 'stop-pill--seq' : '',
        selected ? 'selected' : '',
        status ? `stop-pill--${status}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      title={stopId}
    >
      {seq != null && <span className="stop-pill-seq">{seq}</span>}
      <span className="stop-pill-name">{stopName || '(unnamed stop)'}</span>
      <DiffStatusDot status={status ?? null} />
    </button>
  );
}

/**
 * Small inspector section with a header row and a scrollable body. Used for
 * both the "Lines" block inside a stop card and the "Stops" block inside a
 * route card. Pass `defaultCollapsed` for bulkier, secondary detail (e.g.
 * raw A/B field tables, full stop lists) that clutters the card until the
 * user asks for it; the header stays clickable to toggle either way.
 */
export function InspectorSection({
  title,
  count,
  children,
  defaultCollapsed,
}: {
  title: string;
  count?: number | string;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  return (
    <div className="inspector-section">
      <button
        type="button"
        className="inspector-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`inspector-section-chevron${open ? ' open' : ''}`}>▸</span>
        <span>{title}</span>
        {count !== undefined && <span className="inspector-section-count">{count}</span>}
      </button>
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}
