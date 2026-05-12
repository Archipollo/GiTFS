// Timeline-mode inspector card for a single stop in the active feed.
//
// Renders:
//   - name + raw id + canonical chip + pin/registry buttons
//   - a scrollable list of lines that serve this stop, each clickable to
//     open the matching route in the Route inspector.
//
// The diff-mode equivalent lives in `diff/DiffInspector.tsx` which reuses
// the shared `LinePill` and `InspectorSection` primitives for consistency.

import { useAppStore } from '../state/app-store';
import { useRegistry } from '../registry/useRegistry';
import { useLinesForStop } from './data';
import { LinePill, InspectorSection } from './components';

export default function StopCard() {
  const stop = useAppStore((s) => s.inspectorStop);
  const setInspectorStop = useAppStore((s) => s.setInspectorStop);
  const route = useAppStore((s) => s.inspectorRoute);
  const setInspectorRoute = useAppStore((s) => s.setInspectorRoute);
  const pinnedEntities = useAppStore((s) => s.pinnedEntities);
  const addPinnedEntity = useAppStore((s) => s.addPinnedEntity);
  const removePinnedEntity = useAppStore((s) => s.removePinnedEntity);
  const setRegistryFocus = useAppStore((s) => s.setRegistryFocus);
  const registry = useRegistry();

  const linesState = useLinesForStop(stop?.feedId ?? null, stop?.rawId ?? null);

  if (!stop) return null;

  const canonical =
    stop.canonicalId && registry ? registry.stops[stop.canonicalId] ?? null : null;
  const isPinned =
    canonical != null && pinnedEntities.some((p) => p.canonicalId === canonical.canonicalId);

  const lines = linesState.status === 'ready' ? linesState.value : [];
  const selectedRawId = route?.rawId ?? null;

  return (
    <div className="inspector-card">
      <div className="inspector-card-head">
        <div className="inspector-card-kind">Stop</div>
        <button
          type="button"
          className="inspector-card-close"
          onClick={() => {
            if (isPinned && canonical) {
              removePinnedEntity(canonical.canonicalId);
              if (useAppStore.getState().registryFocus?.canonicalId === canonical.canonicalId)
                setRegistryFocus(null);
            }
            setInspectorStop(null);
          }}
          title="Clear stop selection"
          aria-label="Clear stop selection"
        >
          ×
        </button>
      </div>

      <div className="inspector-card-title">{stop.stopName || '(unnamed stop)'}</div>
      <div className="muted inspector-card-sub">
        <span className="inspector-id-label">ID</span>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{stop.rawId || '—'}</span>
      </div>

      {canonical && (
        <div className="inspector-canonical">
          <div className="muted inspector-canonical-label">Canonical</div>
          <div className="inspector-canonical-id">{canonical.canonicalId}</div>
          <div className="muted inspector-canonical-sub">
            {canonical.memberCount} members · {canonical.feedCount} feed
            {canonical.feedCount === 1 ? '' : 's'}
          </div>
          <div className="inspector-canonical-actions">
            <button
              type="button"
              onClick={() => {
                if (isPinned) {
                  removePinnedEntity(canonical.canonicalId);
                  if (useAppStore.getState().registryFocus?.canonicalId === canonical.canonicalId)
                    setRegistryFocus(null);
                } else {
                  addPinnedEntity({
                    kind: 'stop',
                    canonicalId: canonical.canonicalId,
                    label: canonical.name,
                  });
                  setRegistryFocus({
                    kind: 'stop',
                    canonicalId: canonical.canonicalId,
                    lat: canonical.lat,
                    lon: canonical.lon,
                  });
                }
              }}
              title="Pin this entity so the timeline slider drives its history"
            >
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              onClick={() =>
                setRegistryFocus({
                  kind: 'stop',
                  canonicalId: canonical.canonicalId,
                  lat: canonical.lat,
                  lon: canonical.lon,
                })
              }
            >
              Focus on map
            </button>
          </div>
        </div>
      )}

      <InspectorSection
        title="Lines"
        count={linesState.status === 'ready' ? lines.length : undefined}
      >
        {linesState.status === 'loading' && (
          <div className="muted inspector-placeholder">Loading lines…</div>
        )}
        {linesState.status === 'error' && (
          <div className="muted inspector-placeholder" style={{ color: 'var(--removed)' }}>
            Failed to load lines: {linesState.message}
          </div>
        )}
        {linesState.status === 'ready' && lines.length === 0 && (
          <div className="muted inspector-placeholder">No lines call at this stop.</div>
        )}
        {linesState.status === 'ready' && lines.length > 0 && (
          <div className="line-pill-list">
            {lines.map((line) => (
              <LinePill
                key={line.route_id}
                line={line}
                selected={line.route_id === selectedRawId}
                onClick={() =>
                  setInspectorRoute({
                    feedId: stop.feedId,
                    rawId: line.route_id,
                    shapeId: null,
                    canonicalId: null,
                  })
                }
              />
            ))}
          </div>
        )}
      </InspectorSection>
    </div>
  );
}
