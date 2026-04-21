import { useAppStore } from '../state/app-store';

export default function BottomDrawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const toggle = useAppStore((s) => s.toggleDrawer);

  return (
    <footer className={`drawer ${open ? 'expanded' : 'collapsed'}`}>
      <div className="drawer-header" onClick={toggle}>
        <span>{open ? '▾' : '▸'}</span>
        <span>Text diff · Metrics · Changelog</span>
      </div>
      {open && (
        <div className="drawer-body">
          <p className="muted">
            Raw `.txt`-level diff, metrics dashboard, and human-readable changelog will live here.
          </p>
        </div>
      )}
    </footer>
  );
}
