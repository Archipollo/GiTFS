import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useRegistry, useRegistryStale } from './useRegistry';
import { useBuildRegistry } from './useBuildRegistry';
import {
  getOverrides,
  updateOverrides,
  type RegistrySnapshot,
} from './registry';
import {
  evaluate,
  parseTruthSet,
  type EvaluationResult,
  type TruthSet,
} from './evaluation';
import type { CanonicalStop } from './stops-matcher';
import type { CanonicalRoute } from './routes-matcher';

export default function RegistryPanel() {
  const snapshot = useRegistry();
  const feedOrder = useAppStore((s) => s.feedOrder);
  const stale = useRegistryStale();

  const [tab, setTab] = useState<'browse' | 'evaluate'>('browse');
  const { handleBuild, building } = useBuildRegistry();
  const disabled = building || feedOrder.length === 0;

  const handleExport = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gitfs-registry-${new Date(snapshot.builtAt).toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="registry-panel">
      <div className="registry-header">
        <div className="registry-header-left">
          <button
            className="primary"
            disabled={disabled}
            onClick={handleBuild}
            title={feedOrder.length === 0 ? 'Load at least one feed first' : 'Rebuild the registry over all loaded feeds'}
          >
            {snapshot ? 'Rebuild registry' : 'Build registry'}
          </button>
          {snapshot && (
            <button onClick={handleExport} style={{ marginLeft: 8 }} title="Download the current snapshot as JSON">
              Export JSON
            </button>
          )}
        </div>
        <div className="registry-header-right">
          {snapshot && (
            <span className="muted">
              {Object.keys(snapshot.stops).length.toLocaleString()} canonical stops ·{' '}
              {Object.keys(snapshot.routes).length.toLocaleString()} canonical routes ·{' '}
              from {snapshot.feedIds.length} feed{snapshot.feedIds.length === 1 ? '' : 's'}
            </span>
          )}
          {snapshot && stale && (
            <span
              className="stale-badge"
              title="Loaded feeds don't match the feeds the registry was built from. Rebuild to refresh."
            >
              stale
            </span>
          )}
          {!snapshot && feedOrder.length > 0 && (
            <span className="muted">Registry not built yet.</span>
          )}
        </div>
      </div>

      <nav className="registry-subtabs">
        {(['browse', 'evaluate'] as const).map((t) => (
          <button
            key={t}
            className={`drawer-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'browse' ? 'Browse' : 'Evaluate'}
          </button>
        ))}
      </nav>

      {tab === 'browse' && <BrowseTab snapshot={snapshot} />}
      {tab === 'evaluate' && <EvaluateTab snapshot={snapshot} />}
    </div>
  );
}

// ---- Browse tab ------------------------------------------------------------

function BrowseTab({ snapshot }: { snapshot: RegistrySnapshot | null }) {
  const feeds = useAppStore((s) => s.feeds);
  const setFocus = useAppStore((s) => s.setRegistryFocus);
  const [kind, setKind] = useState<'stops' | 'routes'>('stops');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [minFeeds, setMinFeeds] = useState(1);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const q = query.trim().toLowerCase();
    if (kind === 'stops') {
      const list = Object.values(snapshot.stops);
      const filtered = list.filter((s) =>
        s.feedCount >= minFeeds &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.canonicalId.toLowerCase().includes(q))
      );
      filtered.sort((a, b) => b.feedCount - a.feedCount || b.memberCount - a.memberCount || a.name.localeCompare(b.name));
      return filtered.slice(0, 500);
    }
    const list = Object.values(snapshot.routes);
    const filtered = list.filter((r) =>
      r.feedCount >= minFeeds &&
      (!q ||
        r.shortName.toLowerCase().includes(q) ||
        r.longName.toLowerCase().includes(q) ||
        r.agency.toLowerCase().includes(q) ||
        r.canonicalId.toLowerCase().includes(q))
    );
    filtered.sort((a, b) => b.feedCount - a.feedCount || b.memberCount - a.memberCount || a.shortName.localeCompare(b.shortName));
    return filtered.slice(0, 500);
  }, [snapshot, kind, query, minFeeds]);

  const members = useMemo(() => {
    if (!snapshot || !selectedId) return [];
    const m = kind === 'stops' ? snapshot.stopMembers[selectedId] : snapshot.routeMembers[selectedId];
    return m ?? [];
  }, [snapshot, selectedId, kind]);

  const selected = snapshot && selectedId
    ? (kind === 'stops' ? snapshot.stops[selectedId] : snapshot.routes[selectedId])
    : null;

  if (!snapshot) {
    return (
      <div className="muted" style={{ padding: 6 }}>
        Build the registry to browse canonical entities.
      </div>
    );
  }

  return (
    <div className="registry-browse">
      <div className="registry-toolbar">
        <select value={kind} onChange={(e) => { setKind(e.target.value as 'stops' | 'routes'); setSelectedId(null); }}>
          <option value="stops">Stops</option>
          <option value="routes">Routes</option>
        </select>
        <input
          type="text"
          placeholder={kind === 'stops' ? 'Search stop name' : 'Search short name / long name / agency'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <label className="muted" style={{ fontSize: 12 }}>
          min feeds{' '}
          <input
            type="number"
            value={minFeeds}
            min={1}
            max={Math.max(1, (snapshot.feedIds.length ?? 1))}
            onChange={(e) => setMinFeeds(Math.max(1, Number(e.target.value) | 0))}
            style={{ width: 48 }}
          />
        </label>
      </div>

      <div className="registry-split">
        <div className="registry-list">
          <div className="muted" style={{ fontSize: 11, padding: '4px 6px' }}>
            Showing {rows.length} of {kind === 'stops' ? Object.keys(snapshot.stops).length : Object.keys(snapshot.routes).length} (capped at 500)
          </div>
          {rows.map((row) => {
            if (kind === 'stops') {
              const s = row as CanonicalStop;
              return (
                <button
                  key={s.canonicalId}
                  className={`registry-row ${selectedId === s.canonicalId ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedId(s.canonicalId);
                    setFocus({ kind: 'stop', canonicalId: s.canonicalId, lat: s.lat, lon: s.lon });
                  }}
                >
                  <div className="registry-row-title">{s.name}</div>
                  <div className="registry-row-sub muted">
                    {s.feedCount} feed{s.feedCount === 1 ? '' : 's'} · {s.memberCount} members
                  </div>
                </button>
              );
            }
            const r = row as CanonicalRoute;
            return (
              <button
                key={r.canonicalId}
                className={`registry-row ${selectedId === r.canonicalId ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(r.canonicalId);
                  setFocus({ kind: 'route', canonicalId: r.canonicalId });
                }}
              >
                <div className="registry-row-title">
                  {r.shortName || r.longName || '(unnamed route)'}
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>({r.mode})</span>
                </div>
                <div className="registry-row-sub muted">
                  {r.agency || '—'} · {r.feedCount} feed{r.feedCount === 1 ? '' : 's'} · {r.memberCount} members
                </div>
              </button>
            );
          })}
        </div>

        <div className="registry-detail">
          {!selected && <div className="muted">Select an entity to see its members across feeds.</div>}
          {selected && kind === 'stops' && (
            <StopDetail stop={selected as CanonicalStop} members={members as unknown as MemberRow[]} feedLabel={(id) => feeds[id]?.label ?? id} />
          )}
          {selected && kind === 'routes' && (
            <RouteDetail route={selected as CanonicalRoute} members={members as unknown as MemberRow[]} feedLabel={(id) => feeds[id]?.label ?? id} />
          )}
        </div>
      </div>
    </div>
  );
}

type MemberRow = { feedId: string; rawId: string; [k: string]: unknown };

function StopDetail({
  stop,
  members,
  feedLabel,
}: {
  stop: CanonicalStop;
  members: MemberRow[];
  feedLabel: (id: string) => string;
}) {
  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{stop.name}</div>
      <div className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
        {stop.canonicalId}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {stop.lat.toFixed(5)}, {stop.lon.toFixed(5)} · {stop.memberCount} members · {stop.feedCount} feeds
      </div>
      <table className="registry-members">
        <thead>
          <tr><th>Feed</th><th>Raw ID</th><th>Name in feed</th><th>Lat</th><th>Lon</th></tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr key={`${m.feedId}/${m.rawId}/${i}`}>
              <td>{feedLabel(m.feedId)}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace' }}>{m.rawId}</td>
              <td>{String(m.name ?? '')}</td>
              <td>{Number(m.lat).toFixed(5)}</td>
              <td>{Number(m.lon).toFixed(5)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <OverrideControls kind="stop" members={members} />
    </>
  );
}

function RouteDetail({
  route,
  members,
  feedLabel,
}: {
  route: CanonicalRoute;
  members: MemberRow[];
  feedLabel: (id: string) => string;
}) {
  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {route.shortName || route.longName || '(unnamed)'} <span className="muted" style={{ fontSize: 12 }}>({route.mode})</span>
      </div>
      <div className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
        {route.canonicalId}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {route.agency || '—'} · {route.memberCount} members · {route.feedCount} feeds
      </div>
      <table className="registry-members">
        <thead>
          <tr><th>Feed</th><th>Raw ID</th><th>Short</th><th>Long</th><th>Agency</th></tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr key={`${m.feedId}/${m.rawId}/${i}`}>
              <td>{feedLabel(m.feedId)}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace' }}>{m.rawId}</td>
              <td>{String(m.shortName ?? '')}</td>
              <td>{String(m.longName ?? '')}</td>
              <td>{String(m.agencyName ?? m.agencyId ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <OverrideControls kind="route" members={members} />
    </>
  );
}

function OverrideControls({ kind, members }: { kind: 'stop' | 'route'; members: MemberRow[] }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const unmerge = async (feedId: string, rawId: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await updateOverrides((ov) => {
        if (kind === 'stop') ov.unmergeStops.push({ feedId, rawId });
        else ov.unmergeRoutes.push({ feedId, rawId });
      });
      setMsg('Override saved. Rebuild the registry to apply.');
    } finally {
      setBusy(false);
    }
  };

  if (members.length <= 1) return null;
  const current = getOverrides();
  const unmergeList = kind === 'stop' ? current.unmergeStops : current.unmergeRoutes;

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        Manual overrides
      </div>
      <div style={{ fontSize: 12, marginBottom: 6 }} className="muted">
        Click <em>Split off</em> to force a member to get its own canonical id on next rebuild.
      </div>
      <ul style={{ paddingLeft: 16, margin: 0, fontSize: 12 }}>
        {members.map((m) => {
          const alreadySplit = unmergeList.some((u) => u.feedId === m.feedId && u.rawId === m.rawId);
          return (
            <li key={`${m.feedId}/${m.rawId}`} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
              <span style={{ flex: 1 }}>{m.feedId} / {m.rawId}</span>
              <button
                disabled={busy || alreadySplit}
                onClick={() => unmerge(m.feedId, m.rawId)}
                style={{ padding: '2px 6px', fontSize: 11 }}
              >
                {alreadySplit ? 'scheduled' : 'Split off'}
              </button>
            </li>
          );
        })}
      </ul>
      {msg && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{msg}</div>}
    </div>
  );
}

// ---- Evaluate tab ----------------------------------------------------------

function EvaluateTab({ snapshot }: { snapshot: RegistrySnapshot | null }) {
  const [truth, setTruth] = useState<TruthSet | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseTruthSet(text, file.name);
      setTruth(parsed);
      setFilename(file.name);
      setError(null);
      if (snapshot) setResult(evaluate(snapshot, parsed));
      else setResult(null);
    } catch (err) {
      setTruth(null);
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reRun = () => {
    if (!truth || !snapshot) return;
    setResult(evaluate(snapshot, truth));
  };

  if (!snapshot) {
    return <div className="muted">Build the registry first, then load a truth set to evaluate.</div>;
  }

  return (
    <div className="registry-eval">
      <div className="eval-toolbar">
        <button onClick={() => inputRef.current?.click()}>Load truth set (.json / .csv)</button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        {truth && (
          <button onClick={reRun} style={{ marginLeft: 8 }}>Re-evaluate</button>
        )}
        {filename && <span className="muted" style={{ marginLeft: 12 }}>{filename} · {truth?.pairs.length ?? 0} pairs · kind={truth?.kind}</span>}
      </div>
      {error && <div style={{ color: 'var(--removed)', marginTop: 8 }}>{error}</div>}
      {!truth && !error && (
        <div className="muted" style={{ marginTop: 8 }}>
          Truth format (JSON): <code>{'{ "kind": "stop"|"route", "pairs": [{feedA, rawA, feedB, rawB, same: true|false}, ...] }'}</code>
          <br />
          Or CSV with header <code>feedA,rawA,feedB,rawB,same</code> (optional <code>kind</code> column).
        </div>
      )}
      {result && <EvaluationReport result={result} />}
    </div>
  );
}

function EvaluationReport({ result }: { result: EvaluationResult }) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    <div className="eval-report" style={{ marginTop: 12 }}>
      <div className="eval-metrics">
        <Metric label="Precision" value={pct(result.precision)} hint="TP / (TP + FP)" />
        <Metric label="Recall" value={pct(result.recall)} hint="TP / (TP + FN)" />
        <Metric label="F1" value={pct(result.f1)} hint="harmonic mean" />
        <Metric label="Accuracy" value={pct(result.accuracy)} hint="(TP + TN) / total" />
      </div>
      <table className="registry-members" style={{ marginTop: 10, maxWidth: 420 }}>
        <tbody>
          <tr><td>True positive</td><td>{result.truePositive}</td></tr>
          <tr><td>False positive</td><td>{result.falsePositive}</td></tr>
          <tr><td>True negative</td><td>{result.trueNegative}</td></tr>
          <tr><td>False negative</td><td>{result.falseNegative}</td></tr>
          <tr><td className="muted">Unknown (entity missing)</td><td>{result.unknown}</td></tr>
          <tr><td className="muted">Evaluated pairs</td><td>{result.total}</td></tr>
        </tbody>
      </table>
      {result.mistakes.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Mistakes ({result.mistakes.length})</summary>
          <table className="registry-members" style={{ marginTop: 6 }}>
            <thead>
              <tr><th>Kind</th><th>A</th><th>B</th><th>Pred</th><th>Truth</th><th>Canon A</th><th>Canon B</th></tr>
            </thead>
            <tbody>
              {result.mistakes.slice(0, 200).map((m, i) => (
                <tr key={i}>
                  <td>{m.predicted && !m.pair.same ? 'FP' : 'FN'}</td>
                  <td>{m.pair.feedA}/{m.pair.rawA}</td>
                  <td>{m.pair.feedB}/{m.pair.rawB}</td>
                  <td>{m.predicted ? 'same' : 'diff'}</td>
                  <td>{m.pair.same ? 'same' : 'diff'}</td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{m.canonicalA ?? '—'}</td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{m.canonicalB ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="eval-metric">
      <div className="eval-metric-value">{value}</div>
      <div className="eval-metric-label">{label}</div>
      <div className="muted" style={{ fontSize: 11 }}>{hint}</div>
    </div>
  );
}
