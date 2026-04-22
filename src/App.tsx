import { useEffect } from 'react';
import TopBar from './app-shell/TopBar';
import LeftPanel from './app-shell/LeftPanel';
import RightPanel from './app-shell/RightPanel';
import BottomDrawer from './app-shell/BottomDrawer';
import MapView from './map/MapView';
import TimelineStrip from './timeline/TimelineStrip';
import { rehydrateOnBoot } from './gtfs/feed-loader';
import { rehydrateRegistryOnBoot } from './registry/registry';
import './app-shell/layout.css';

export default function App() {
  useEffect(() => {
    rehydrateOnBoot();
    rehydrateRegistryOnBoot();
  }, []);

  return (
    <div className="app-root">
      <TopBar />
      <div className="app-body">
        <LeftPanel />
        <main className="app-map">
          <MapView />
          <TimelineStrip />
        </main>
        <RightPanel />
      </div>
      <BottomDrawer />
    </div>
  );
}
