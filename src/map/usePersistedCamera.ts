// Shared camera persistence for the overview maps (network / split / timeline).
// Each of those views constructs its own MapLibre instance, so switching
// layouts would otherwise reset the camera to the all-Austria default. This
// hook restores the last camera on construction and saves it on every
// `moveend`, keeping the current view consistent across layout switches.
//
// The stored camera is read non-reactively (via `getState`, not a selector) so
// panning never re-renders the view or re-runs its effects — writing goes
// through the stable `setMapCamera` action.

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useAppStore, type MapCamera } from '../state/app-store';

/**
 * @param mapRef  the view's MapLibre instance ref
 * @param ready   whether the map's `load` has fired (layers/sources ready)
 * @param save    whether this view should write camera updates back to the
 *   store. Split view sets this only on its driver pane; RouteDetailView passes
 *   `false` so drilling into a route never clobbers the overview camera.
 * @returns the camera to construct the map from (persisted, or null on first run)
 */
export function usePersistedCamera(
  mapRef: { current: MapLibreMap | null },
  ready: boolean,
  save = true,
): MapCamera | null {
  // Read once, at construction time — a selector here would re-render on pan.
  const initialCamera = useRef(useAppStore.getState().mapCamera).current;
  const setMapCamera = useAppStore((s) => s.setMapCamera);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !save) return;
    const persist = () => {
      const c = map.getCenter();
      setMapCamera({
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
    };
    map.on('moveend', persist);
    return () => {
      map.off('moveend', persist);
    };
  }, [mapRef, ready, save, setMapCamera]);

  return initialCamera;
}
