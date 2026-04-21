import { useAppStore, selectMapBusy, selectMapBusyLabel } from '../state/app-store';

export default function MapOverlay() {
  const busy = useAppStore(selectMapBusy);
  const label = useAppStore(selectMapBusyLabel);
  if (!busy) return null;
  return (
    <div className="map-overlay" role="status" aria-live="polite">
      <div className="map-overlay-card">
        <span className="spinner" aria-hidden />
        <span className="map-overlay-label">{label || 'Working…'}</span>
      </div>
    </div>
  );
}
