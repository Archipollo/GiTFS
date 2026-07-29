// Global analysis toolbox: a single popover menu (same shell as UploadMenu /
// FeedBar) that lets the user switch on an analysis overlay from any view —
// network overview, split view, route detail, or plain single-feed/timeline
// browsing. Frequency (trips/week, delta when a diff pair is loaded, absolute
// otherwise) and Population (people per cell from GHS-POP, delta in diff
// mode) are both additional rows in the same popover, keyed off the same
// `analysisMode` store field.

import { useEffect, useRef, useState } from 'react';
import { useAppStore, type AnalysisMode } from '../state/app-store';

const MODE_LABEL: Record<AnalysisMode, string> = {
  none: 'None',
  frequency: 'Frequency',
  population: 'Population',
  gueteklassen: 'ÖV-Güteklassen',
};

const POPULATION_SOURCE_LABEL: Record<'ghs' | 'zsp', string> = {
  ghs: 'GHS-POP',
  zsp: 'Zählsprengel',
};

export function AnalysisMenu() {
  const analysisMode = useAppStore((s) => s.analysisMode);
  const setAnalysisMode = useAppStore((s) => s.setAnalysisMode);
  const populationSource = useAppStore((s) => s.populationSource);
  const setPopulationSource = useAppStore((s) => s.setPopulationSource);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="upload-menu" ref={menuRef}>
      <button
        className={`analysis-menu-trigger${analysisMode !== 'none' ? ' primary' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Analysis: {MODE_LABEL[analysisMode]} ▾
      </button>
      {open && (
        <div className="upload-menu-popover" role="menu">
          <div className="route-detail-mode-switch">
            {(['none', 'frequency', 'population', 'gueteklassen'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={analysisMode === mode ? 'on' : 'off'}
                onClick={() => setAnalysisMode(mode)}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          {analysisMode === 'population' && (
            <div className="route-detail-mode-switch">
              {(['ghs', 'zsp'] as const).map((source) => (
                <button
                  key={source}
                  type="button"
                  className={populationSource === source ? 'on' : 'off'}
                  onClick={() => setPopulationSource(source)}
                >
                  {POPULATION_SOURCE_LABEL[source]}
                </button>
              ))}
            </div>
          )}
          <div className="upload-menu-hint muted">
            {analysisMode === 'frequency'
              ? 'Lines colored by trips/week gained or lost, when comparing two feeds.'
              : analysisMode === 'population'
                ? populationSource === 'ghs'
                  ? 'Cells colored by people per ~100m cell (GHS-POP) gained or lost, when comparing two feeds.'
                  : 'Zählsprengel colored by current Statistik Austria registry population — a single snapshot, not tied to feed year.'
                : analysisMode === 'gueteklassen'
                  ? 'Cells colored by ÖV-Güteklasse (A=best, G=worst) using ÖROK public-transport accessibility grading.'
                  : 'Pick an analysis overlay to apply across every view.'}
          </div>
        </div>
      )}
    </div>
  );
}
