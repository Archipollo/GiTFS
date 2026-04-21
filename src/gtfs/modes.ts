// Classification of GTFS route_type (incl. the Google Extended types commonly used
// in Austrian feeds) into a small set of display modes.

export type Mode = 'rail' | 'metro' | 'tram' | 'bus' | 'other';

export const MODES: Mode[] = ['rail', 'metro', 'tram', 'bus', 'other'];

export const MODE_LABEL: Record<Mode, string> = {
  rail: 'Rail',
  metro: 'Metro / U-Bahn',
  tram: 'Tram / Straßenbahn',
  bus: 'Bus',
  other: 'Other / Unknown',
};

export const MODE_COLOR: Record<Mode, string> = {
  rail: '#dc2626',
  metro: '#8b5cf6',
  tram: '#f59e0b',
  bus: '#2563eb',
  other: '#6b7280',
};

// Higher = wins when picking a stop's primary mode for colouring purposes.
// Rail beats metro beats tram beats bus beats other. Arbitrary but consistent.
const PRIORITY: Record<Mode, number> = {
  rail: 5, metro: 4, tram: 3, bus: 2, other: 1,
};

export function classifyRouteType(rt: number | null | undefined): Mode {
  if (rt == null || Number.isNaN(rt)) return 'other';
  // Basic GTFS types
  if (rt === 0) return 'tram';
  if (rt === 1) return 'metro';
  if (rt === 2) return 'rail';
  if (rt === 3) return 'bus';
  if (rt === 11) return 'bus';      // trolleybus
  if (rt === 12) return 'metro';    // monorail
  // Extended types (Google / GTFS extension)
  if (rt >= 100 && rt <= 117) return 'rail';   // railway service
  if (rt >= 200 && rt <= 209) return 'bus';    // coach service — treat as bus
  if (rt >= 300 && rt <= 399) return 'rail';   // suburban railway
  if (rt >= 400 && rt <= 405) return 'metro';  // urban railway / metro / monorail
  if (rt >= 700 && rt <= 716) return 'bus';    // bus service
  if (rt >= 800 && rt <= 802) return 'bus';    // trolleybus service
  if (rt >= 900 && rt <= 906) return 'tram';   // tram service
  return 'other';
}

export function primaryMode(modes: Iterable<Mode>): Mode {
  let best: Mode = 'other';
  let bestP = -1;
  for (const m of modes) {
    const p = PRIORITY[m];
    if (p > bestP) { bestP = p; best = m; }
  }
  return best;
}
