import { useAppStore, type AppState } from '../state/app-store';
import RegistryPanel from '../registry/RegistryPanel';

type Tab = AppState['drawerTab'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'registry', label: 'Registry' },
  { id: 'diff', label: 'Text diff' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'changelog', label: 'Changelog' },
];

export default function BottomDrawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const toggle = useAppStore((s) => s.toggleDrawer);
  const tab = useAppStore((s) => s.drawerTab);
  const setTab = useAppStore((s) => s.setDrawerTab);

  return (
    <footer className={`drawer ${open ? 'expanded' : 'collapsed'}`}>
      <div className="drawer-header">
        <button
          className="drawer-toggle"
          onClick={toggle}
          title={open ? 'Collapse drawer' : 'Expand drawer'}
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
        >
          {open ? '▾' : '▸'}
        </button>
        <nav className="drawer-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`drawer-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => {
                setTab(t.id);
                if (!open) toggle();
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      {open && (
        <div className="drawer-body">
          {tab === 'registry' && <RegistryPanel />}
          {tab === 'diff' && (
            <p className="muted">
              Raw `.txt`-level diff will live here (Monaco editor, M4).
            </p>
          )}
          {tab === 'metrics' && (
            <p className="muted">Metrics dashboard will live here (M5).</p>
          )}
          {tab === 'changelog' && (
            <p className="muted">Human-readable changelog will live here (M4).</p>
          )}
        </div>
      )}
    </footer>
  );
}
