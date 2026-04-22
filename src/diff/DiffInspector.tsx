// Right-panel inspector for diff mode.
//
// Shows the currently-focused canonical stop (or route) side-by-side for A
// and B, with changed fields highlighted. Focus is driven by either a
// map-click (setDiffFocus) or by selecting a row in the drawer's changelog.

import { useAppStore } from '../state/app-store';
import { useDiff } from './useDiff';
import type { DiffResult, StopDiffEntry, RouteDiffEntry, StopSide, RouteSide } from './engine';
import { DIFF_COLOR } from './geojson';

export default function DiffInspector() {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const diffFocus = useAppStore((s) => s.diffFocus);
  const feedALabel = useAppStore((s) =>
    activeFeedId ? s.feeds[activeFeedId]?.label ?? activeFeedId : null,
  );
  const feedBLabel = useAppStore((s) =>
    compareFeedId ? s.feeds[compareFeedId]?.label ?? compareFeedId : null,
  );
  const setDiffFocus = useAppStore((s) => s.setDiffFocus);

  const diff = useDiff(activeFeedId, compareFeedId);

  if (diff.kind === 'no-registry') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">
          Build the Entity Registry first so diffs can line entities up across
          feeds.
        </p>
      </div>
    );
  }
  if (diff.kind === 'loading') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">Computing diff…</p>
      </div>
    );
  }
  if (diff.kind === 'error') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted" style={{ color: 'var(--removed)' }}>
          Diff failed: {diff.message}
        </p>
      </div>
    );
  }
  if (diff.kind === 'idle') {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">
          Pick two feeds (A and B) in the left panel to see changes.
        </p>
      </div>
    );
  }

  const result = diff.result;

  if (!diffFocus) {
    return (
      <div>
        <h3>Inspector</h3>
        <DiffTotals result={result} />
        <p className="muted">
          Click a colored dot on the map (or a row in the Changelog drawer)
          to inspect that change.
        </p>
      </div>
    );
  }

  if (diffFocus.kind === 'stop') {
    const entry = result.stops.find((e) => e.canonicalId === diffFocus.canonicalId);
    if (!entry) {
      return (
        <div>
          <h3>Inspector</h3>
          <p className="muted">Focused stop not found in current diff.</p>
          <button onClick={() => setDiffFocus(null)}>Clear focus</button>
        </div>
      );
    }
    return (
      <div>
        <h3>Inspector</h3>
        <StopInspector entry={entry} aLabel={feedALabel} bLabel={feedBLabel} />
        <button
          style={{ marginTop: 10, padding: '4px 8px', fontSize: 11 }}
          onClick={() => setDiffFocus(null)}
        >
          Clear focus
        </button>
      </div>
    );
  }

  // Route focus
  const entry = result.routes.find((e) => e.canonicalId === diffFocus.canonicalId);
  if (!entry) {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="muted">Focused route not found in current diff.</p>
        <button onClick={() => setDiffFocus(null)}>Clear focus</button>
      </div>
    );
  }
  return (
    <div>
      <h3>Inspector</h3>
      <RouteInspector entry={entry} aLabel={feedALabel} bLabel={feedBLabel} />
      <button
        style={{ marginTop: 10, padding: '4px 8px', fontSize: 11 }}
        onClick={() => setDiffFocus(null)}
      >
        Clear focus
      </button>
    </div>
  );
}

function DiffTotals({ result }: { result: DiffResult }) {
  const s = result.summary.stops;
  const r = result.summary.routes;
  const totalStops = s.added + s.removed + s.moved + s.renamed + s.unchanged;
  const totalRoutes = r.added + r.removed + r.renumbered + r.modified + r.unchanged;
  return (
    <table className="diff-inspector-totals">
      <tbody>
        <tr>
          <td className="muted">Stops</td>
          <td>
            {totalStops} total · {s.added + s.removed + s.moved + s.renamed} changed
          </td>
        </tr>
        <tr>
          <td className="muted">Routes</td>
          <td>
            {totalRoutes} total · {r.added + r.removed + r.renumbered + r.modified} changed
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- stop side panel -------------------------------------------------------

function StopInspector({
  entry,
  aLabel,
  bLabel,
}: {
  entry: StopDiffEntry;
  aLabel: string | null;
  bLabel: string | null;
}) {
  const { status, a, b } = entry;
  const nameChanged = !!a && !!b && a.name.trim() !== b.name.trim();
  return (
    <div>
      <StatusBadge status={status} />
      <div style={{ fontWeight: 600, marginTop: 4 }}>
        {entry.canonical.name || '(unnamed)'}
      </div>
      <div className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
        {entry.canonicalId}
      </div>
      {entry.moved && (
        <div className="muted" style={{ marginTop: 4 }}>
          Moved {entry.distM.toFixed(0)} m
        </div>
      )}
      <div className="diff-ab">
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--a">A · {aLabel ?? '—'}</div>
          {a ? (
            <StopSideTable side={a} name={a.name} highlight={{ name: nameChanged, pos: entry.moved }} />
          ) : (
            <div className="diff-ab-absent">not present</div>
          )}
        </div>
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--b">B · {bLabel ?? '—'}</div>
          {b ? (
            <StopSideTable side={b} name={b.name} highlight={{ name: nameChanged, pos: entry.moved }} />
          ) : (
            <div className="diff-ab-absent">not present</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StopSideTable({
  side,
  name,
  highlight,
}: {
  side: StopSide;
  name: string;
  highlight: { name: boolean; pos: boolean };
}) {
  return (
    <table className="diff-ab-table">
      <tbody>
        <tr className={highlight.name ? 'changed' : ''}>
          <td className="muted">Name</td>
          <td>{name || '(unnamed)'}</td>
        </tr>
        <tr className={highlight.pos ? 'changed' : ''}>
          <td className="muted">Lat</td>
          <td>{side.lat.toFixed(5)}</td>
        </tr>
        <tr className={highlight.pos ? 'changed' : ''}>
          <td className="muted">Lon</td>
          <td>{side.lon.toFixed(5)}</td>
        </tr>
        <tr>
          <td className="muted">Raw IDs</td>
          <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>
            {side.rawIds.join(', ') || '—'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- route side panel ------------------------------------------------------

function RouteInspector({
  entry,
  aLabel,
  bLabel,
}: {
  entry: RouteDiffEntry;
  aLabel: string | null;
  bLabel: string | null;
}) {
  const { a, b } = entry;
  const highlight = {
    short: !!a && !!b && a.shortName !== b.shortName,
    long: !!a && !!b && a.longName !== b.longName,
    agency: !!a && !!b && a.agencyName !== b.agencyName,
    mode: !!a && !!b && a.mode !== b.mode,
  };
  return (
    <div>
      <StatusBadge status={entry.status} />
      <div style={{ fontWeight: 600, marginTop: 4 }}>
        {entry.canonical.shortName || entry.canonical.longName || '(unnamed route)'}
      </div>
      <div className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
        {entry.canonicalId}
      </div>
      {entry.renumbering && (
        <div className="muted" style={{ marginTop: 4 }}>
          Renumbered from <code>{entry.renumbering.fromCanonicalId}</code> to{' '}
          <code>{entry.renumbering.toCanonicalId}</code>
        </div>
      )}
      <div className="diff-ab">
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--a">A · {aLabel ?? '—'}</div>
          {a ? <RouteSideTable side={a} highlight={highlight} /> : <div className="diff-ab-absent">not present</div>}
        </div>
        <div className="diff-ab-col">
          <div className="diff-ab-head diff-ab-head--b">B · {bLabel ?? '—'}</div>
          {b ? <RouteSideTable side={b} highlight={highlight} /> : <div className="diff-ab-absent">not present</div>}
        </div>
      </div>
    </div>
  );
}

function RouteSideTable({
  side,
  highlight,
}: {
  side: RouteSide;
  highlight: { short: boolean; long: boolean; agency: boolean; mode: boolean };
}) {
  return (
    <table className="diff-ab-table">
      <tbody>
        <tr className={highlight.short ? 'changed' : ''}>
          <td className="muted">Short</td>
          <td>{side.shortName || '—'}</td>
        </tr>
        <tr className={highlight.long ? 'changed' : ''}>
          <td className="muted">Long</td>
          <td>{side.longName || '—'}</td>
        </tr>
        <tr className={highlight.agency ? 'changed' : ''}>
          <td className="muted">Agency</td>
          <td>{side.agencyName || '—'}</td>
        </tr>
        <tr className={highlight.mode ? 'changed' : ''}>
          <td className="muted">Mode</td>
          <td>{side.mode}</td>
        </tr>
        <tr>
          <td className="muted">Raw IDs</td>
          <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>
            {side.rawIds.join(', ') || '—'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---- helpers ---------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const color = DIFF_COLOR[status as keyof typeof DIFF_COLOR] ?? '#94a3b8';
  return (
    <span
      className="diff-status-badge"
      style={{ background: `${color}22`, color, borderColor: `${color}55` }}
    >
      {status}
    </span>
  );
}
