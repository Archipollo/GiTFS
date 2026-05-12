import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { fetchRouteMetas, type LineForStop } from '../gtfs/queries';
import { lookupRoute } from '../registry/registry';
import { LinePill, InspectorSection } from './components';

export function SegmentCard() {
  const segment = useAppStore((s) => s.inspectorSegment);
  const setInspectorSegment = useAppStore((s) => s.setInspectorSegment);
  const setInspectorRoute = useAppStore((s) => s.setInspectorRoute);

  const [lines, setLines] = useState<LineForStop[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!segment) { setLines([]); return; }
    let cancelled = false;
    setLoading(true);
    fetchRouteMetas(segment.feedId, segment.routeIds)
      .then((rows) => { if (!cancelled) { setLines(rows); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [segment?.feedId, segment?.routeIds]);

  if (!segment) return null;

  return (
    <div className="inspector-card">
      <div className="inspector-card-head">
        <div className="inspector-card-kind">Section</div>
        <button
          type="button"
          className="inspector-card-close"
          onClick={() => setInspectorSegment(null)}
          title="Clear section selection"
          aria-label="Clear section selection"
        >
          ×
        </button>
      </div>

      <InspectorSection
        title="Lines on this section"
        count={loading ? undefined : lines.length}
      >
        {loading && <div className="muted inspector-placeholder">Loading lines…</div>}
        {!loading && lines.length === 0 && (
          <div className="muted inspector-placeholder">No lines found.</div>
        )}
        {!loading && lines.length > 0 && (
          <div className="line-pill-list">
            {lines.map((line) => (
              <LinePill
                key={line.route_id}
                line={line}
                onClick={() => {
                  const canonical = lookupRoute(segment.feedId, line.route_id)?.canonicalId ?? null;
                  setInspectorRoute({
                    feedId: segment.feedId,
                    rawId: line.route_id,
                    shapeId: segment.shapeId,
                    canonicalId: canonical,
                  });
                }}
              />
            ))}
          </div>
        )}
      </InspectorSection>
    </div>
  );
}
