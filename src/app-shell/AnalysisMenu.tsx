// Global analysis toolbox: a single popover menu (same shell as UploadMenu /
// FeedBar) that lets the user switch on an analysis overlay from any view —
// network overview, split view, route detail, or plain single-feed/timeline
// browsing. Today: Frequency (trips/week, delta when a diff pair is loaded,
// absolute otherwise). Future modes (e.g. population density) are additional
// rows in the same popover, keyed off the same `analysisMode` store field.

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../state/app-store';

const MODE_LABEL: Record<'none' | 'frequency', string> = {
  none: 'None',
  frequency: 'Frequency',
};

export function AnalysisMenu() {
  const analysisMode = useAppStore((s) => s.analysisMode);
  const setAnalysisMode = useAppStore((s) => s.setAnalysisMode);
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
        className={analysisMode !== 'none' ? 'primary' : undefined}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Analysis: {MODE_LABEL[analysisMode]} ▾
      </button>
      {open && (
        <div className="upload-menu-popover" role="menu">
          <div className="route-detail-mode-switch">
            {(['none', 'frequency'] as const).map((mode) => (
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
          <div className="upload-menu-hint muted">
            {analysisMode === 'frequency'
              ? 'Lines colored by trips/week — gained or lost, when comparing two feeds.'
              : 'Pick an analysis overlay to apply across every view.'}
          </div>
        </div>
      )}
    </div>
  );
}
