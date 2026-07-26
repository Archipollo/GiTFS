// Tracks a map instance's current viewport as a plain [west, south, east,
// north] bbox, debounced on `moveend` — used by the population analysis
// layer to know what extent to fetch. There's no store-level "current
// extent" (only `mapCamera`'s center/zoom/bearing/pitch), and a bbox is only
// ever needed by whichever view is actively fetching population data, so
// this stays a local hook rather than new global state.

import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bbox } from '../gtfs/population';

const DEBOUNCE_MS = 300;

export function useMapBounds(mapRef: { current: MapLibreMap | null }, ready: boolean): Bbox | null {
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const capture = () => {
      const b = map.getBounds();
      setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    capture();

    const onMoveEnd = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(capture, DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [mapRef, ready]);

  return bbox;
}
