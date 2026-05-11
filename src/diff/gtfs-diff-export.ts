// GTFS-Diff v1 CSV export.
//
// Specification: https://github.com/MobilityData/gtfs-diff/blob/main/spec/v1/specification.md
// Format: CSV with 8 columns — id, file, action, target, identifier,
//         initial_value, new_value, note.
// The identifier / initial_value / new_value columns contain JSON objects
// serialised and CSV-quoted inline.

import type { DiffResult } from './engine';
import type { Mode } from '../gtfs/modes';

// ---- CSV helpers -----------------------------------------------------------

function csvField(v: string | object | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Always quote JSON objects; also quote strings containing commas/quotes/newlines/carriage returns.
  if (typeof v === 'object' || s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: (string | object | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}

const HEADER = 'id,file,action,target,identifier,initial_value,new_value,note';

// ---- GTFS route_type mapping -----------------------------------------------

const MODE_TO_ROUTE_TYPE: Record<Mode, string> = {
  tram: '0',
  metro: '1',
  rail: '2',
  bus: '3',
  other: '3',
};

// ---- Main export -----------------------------------------------------------

export function exportGtfsDiffV1(result: DiffResult): string {
  const rows: string[] = [HEADER];
  let id = 1;

  const emit = (
    file: string,
    action: 'add' | 'delete' | 'update',
    identifier: object | null,
    initialValue: object | null,
    newValue: object | null,
    note?: string,
  ) => {
    rows.push(csvRow([
      String(id++),
      file,
      action,
      'row',
      identifier,
      initialValue,
      newValue,
      note ?? '',
    ]));
  };

  // ---- stops.txt -----------------------------------------------------------

  for (const stop of result.stops) {
    if (stop.status === 'unchanged') continue;

    if (stop.status === 'added' && stop.b) {
      for (const rawId of stop.b.rawIds) {
        emit('stops.txt', 'add', null, null, {
          stop_id: rawId,
          stop_name: stop.b.name,
          stop_lat: stop.b.lat.toFixed(6),
          stop_lon: stop.b.lon.toFixed(6),
        });
      }
      continue;
    }

    if (stop.status === 'removed' && stop.a) {
      for (const rawId of stop.a.rawIds) {
        emit('stops.txt', 'delete', { stop_id: rawId }, {
          stop_id: rawId,
          stop_name: stop.a.name,
          stop_lat: stop.a.lat.toFixed(6),
          stop_lon: stop.a.lon.toFixed(6),
        }, null);
      }
      continue;
    }

    // moved and/or renamed — both sides present
    if ((stop.status === 'moved' || stop.status === 'renamed') && stop.a && stop.b) {
      const rawId = stop.a.rawIds[0];
      const initial: Record<string, string> = {};
      const updated: Record<string, string> = {};
      if (stop.moved) {
        initial.stop_lat = stop.a.lat.toFixed(6);
        initial.stop_lon = stop.a.lon.toFixed(6);
        updated.stop_lat = stop.b.lat.toFixed(6);
        updated.stop_lon = stop.b.lon.toFixed(6);
      }
      if (stop.renamed) {
        initial.stop_name = stop.a.name;
        updated.stop_name = stop.b.name;
      }
      emit('stops.txt', 'update', { stop_id: rawId }, initial, updated);
    }
  }

  // ---- routes.txt ----------------------------------------------------------

  for (const route of result.routes) {
    if (route.status === 'unchanged') continue;

    if (route.status === 'added' && route.b) {
      for (const rawId of route.b.rawIds) {
        emit('routes.txt', 'add', null, null, {
          route_id: rawId,
          route_short_name: route.b.shortName,
          route_long_name: route.b.longName,
          agency_id: route.b.agencyName,
          route_type: MODE_TO_ROUTE_TYPE[route.b.mode],
        });
      }
      continue;
    }

    if (route.status === 'removed' && route.a) {
      for (const rawId of route.a.rawIds) {
        emit('routes.txt', 'delete', { route_id: rawId }, {
          route_id: rawId,
          route_short_name: route.a.shortName,
          route_long_name: route.a.longName,
          agency_id: route.a.agencyName,
          route_type: MODE_TO_ROUTE_TYPE[route.a.mode],
        }, null);
      }
      continue;
    }

    if (route.status === 'modified' && route.a && route.b) {
      const rawId = route.a.rawIds[0];
      const initial: Record<string, string> = {};
      const updated: Record<string, string> = {};
      if (route.a.longName !== route.b.longName) {
        initial.route_long_name = route.a.longName;
        updated.route_long_name = route.b.longName;
      }
      if (route.a.agencyName !== route.b.agencyName) {
        initial.agency_id = route.a.agencyName;
        updated.agency_id = route.b.agencyName;
      }
      if (Object.keys(initial).length > 0) {
        emit('routes.txt', 'update', { route_id: rawId }, initial, updated);
      }
      continue;
    }

    // renumbered: the short name changed — model as delete of old + add of new
    if (route.status === 'renumbered' && route.a && route.b) {
      for (const rawId of route.a.rawIds) {
        emit('routes.txt', 'delete', { route_id: rawId }, {
          route_id: rawId,
          route_short_name: route.a.shortName,
          route_long_name: route.a.longName,
          agency_id: route.a.agencyName,
          route_type: MODE_TO_ROUTE_TYPE[route.a.mode],
        }, null, 'renumbered');
      }
      for (const rawId of route.b.rawIds) {
        emit('routes.txt', 'add', null, null, {
          route_id: rawId,
          route_short_name: route.b.shortName,
          route_long_name: route.b.longName,
          agency_id: route.b.agencyName,
          route_type: MODE_TO_ROUTE_TYPE[route.b.mode],
        }, 'renumbered');
      }
    }
  }

  return rows.join('\n');
}
