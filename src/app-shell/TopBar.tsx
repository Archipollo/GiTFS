import { useAppStore, type AppMode } from '../state/app-store';
import UploadMenu from './UploadMenu';

const MODES: { id: AppMode; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'diff', label: 'Diff' },
  { id: 'scenario', label: 'Scenario' },
];

export default function TopBar() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const feedCount = useAppStore((s) => s.feedOrder.length);

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
      <UploadMenu />
    </header>
  );
}
