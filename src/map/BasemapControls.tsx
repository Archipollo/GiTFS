// The map-style cycle button and historical-satellite toggle, shared by every
// map view (timeline, network diff, split diff) so the options stay identical
// wherever a map is shown.

import { useAppStore } from '../state/app-store';

export function BasemapControls() {
  const mapStyle = useAppStore((s) => s.mapStyle);
  const setMapStyle = useAppStore((s) => s.setMapStyle);
  const historicalBasemap = useAppStore((s) => s.historicalBasemap);
  const setHistoricalBasemap = useAppStore((s) => s.setHistoricalBasemap);

  return (
    <>
      <button
        className="map-basemap-toggle"
        title={
          mapStyle === 'positron' ? 'Switch to standard map (OSM)' :
          mapStyle === 'standard' ? 'Switch to dark map' :
          'Switch to light map (Positron)'
        }
        onClick={() =>
          setMapStyle(
            mapStyle === 'positron' ? 'standard' :
            mapStyle === 'standard' ? 'dark' :
            'positron',
          )
        }
      >
        {mapStyle === 'positron' ? '○' : mapStyle === 'standard' ? '◑' : '●'}
      </button>
      <button
        className={`map-basemap-toggle map-historical-toggle${historicalBasemap ? ' active' : ''}`}
        title={historicalBasemap ? 'Disable historical satellite basemap' : 'Enable historical satellite basemap'}
        onClick={() => setHistoricalBasemap(!historicalBasemap)}
      >
        <i className="fa-solid fa-satellite" />
      </button>
    </>
  );
}
