import type { Map as MapLibreMap } from 'maplibre-gl';

export interface SnapshotLegendInfo {
  yearLabel: string;
  feedLabel: string;
  stopCount?: number;
  routeCount?: number;
  addedStopCount?: number;
  addedRouteCount?: number;
  baselineLabel?: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Composite the current MapLibre frame with a legend box (year, feed,
 * stop/route counts, delta since baseline) and trigger a PNG download.
 * Requires the map to have been created with `preserveDrawingBuffer: true`.
 */
export function exportMapSnapshot(map: MapLibreMap, info: SnapshotLegendInfo): void {
  const mapCanvas = map.getCanvas();
  const canvas = document.createElement('canvas');
  canvas.width = mapCanvas.width;
  canvas.height = mapCanvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(mapCanvas, 0, 0);

  const lines: string[] = [info.yearLabel, info.feedLabel];
  if (info.stopCount != null || info.routeCount != null) {
    lines.push(`${info.stopCount ?? '—'} stops · ${info.routeCount ?? '—'} routes`);
  }
  if (info.baselineLabel && (info.addedStopCount != null || info.addedRouteCount != null)) {
    lines.push(`+${info.addedStopCount ?? 0} stops / +${info.addedRouteCount ?? 0} routes since ${info.baselineLabel}`);
  }

  const scale = canvas.width / 1024;
  const padding = 16 * scale;
  const lineHeight = 22 * scale;
  const boxWidth = 420 * scale;
  const boxHeight = padding * 2 + lineHeight * lines.length;
  const boxX = padding;
  const boxY = canvas.height - boxHeight - padding;

  ctx.fillStyle = 'rgba(15, 20, 30, 0.72)';
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.font = i === 0 ? `${18 * scale}px sans-serif` : `${13 * scale}px sans-serif`;
    ctx.fillText(line, boxX + padding, boxY + padding + i * lineHeight);
  });

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gitfs-timeline-${slugify(info.yearLabel)}-${slugify(info.feedLabel)}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
