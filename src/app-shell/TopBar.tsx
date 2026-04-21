import { useRef } from 'react';
import { useAppStore, type AppMode } from '../state/app-store';
import { ingestGtfsZip } from '../gtfs/ingest';

const MODES: { id: AppMode; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'diff', label: 'Diff' },
  { id: 'scenario', label: 'Scenario' },
];

export default function TopBar() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const ingesting = useAppStore((s) => s.ingesting);
  const feedCount = useAppStore((s) => s.feedOrder.length);
  const fileInput = useRef<HTMLInputElement>(null);

  const onPick = () => fileInput.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await ingestGtfsZip(file);
    } catch (err) {
      console.error(err);
      alert(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <header className="topbar">
      <span className="brand">GiTFS</span>
      <nav className="tabs">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`tab ${mode === m.id ? 'active' : ''}`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <span className="muted">{feedCount} feed{feedCount === 1 ? '' : 's'}</span>
      {ingesting && <span className="muted">Loading: {ingesting.progress}</span>}
      <button className="primary" onClick={onPick} disabled={!!ingesting}>
        Load GTFS zip
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        style={{ display: 'none' }}
        onChange={onFile}
      />
    </header>
  );
}
