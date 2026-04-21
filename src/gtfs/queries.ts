import { getConnection } from './duckdb';
import { qualifiedTable } from './ingest';
import { classifyRouteType, primaryMode, type Mode } from './modes';
import { ensureFeedTablesLoaded } from './feed-loader';

export interface StopPoint {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  modes: Mode[];           // set of modes this stop is served by (empty = never referenced)
  primary_mode: Mode;
}

export interface ShapePolyline {
  shape_id: string;
  coords: [number, number][]; // [lon, lat]
  modes: Mode[];
  primary_mode: Mode;
}

export async function fetchStops(feedId: string): Promise<StopPoint[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const stopsT = qualifiedTable(feedId, 'stops.txt');
    const hasStopTimes = await tableExists(conn, feedId, 'stop_times');
    const hasTrips = await tableExists(conn, feedId, 'trips');
    const hasRoutes = await tableExists(conn, feedId, 'routes');

    // Build a (stop_id -> set of route_types) lookup only if the join chain is available.
    const stopRouteTypes = new Map<string, Set<number>>();
    if (hasStopTimes && hasTrips && hasRoutes) {
      const st = qualifiedTable(feedId, 'stop_times.txt');
      const tr = qualifiedTable(feedId, 'trips.txt');
      const rt = qualifiedTable(feedId, 'routes.txt');
      const res = await conn.query(`
        SELECT DISTINCT st.stop_id AS stop_id,
               TRY_CAST(r.route_type AS INTEGER) AS route_type
        FROM ${st} st
        JOIN ${tr} t ON st.trip_id = t.trip_id
        JOIN ${rt} r ON t.route_id = r.route_id
        WHERE TRY_CAST(r.route_type AS INTEGER) IS NOT NULL
      `);
      for (const row of res.toArray()) {
        const id = String(row.stop_id);
        const rtVal = row.route_type as number;
        let set = stopRouteTypes.get(id);
        if (!set) { set = new Set(); stopRouteTypes.set(id, set); }
        set.add(rtVal);
      }
    }

    const res = await conn.query(`
      SELECT stop_id,
             COALESCE(stop_name, '') AS stop_name,
             TRY_CAST(stop_lat AS DOUBLE) AS lat,
             TRY_CAST(stop_lon AS DOUBLE) AS lon
      FROM ${stopsT}
      WHERE TRY_CAST(stop_lat AS DOUBLE) IS NOT NULL
        AND TRY_CAST(stop_lon AS DOUBLE) IS NOT NULL
    `);
    return res.toArray().map((r) => {
      const stop_id = String(r.stop_id);
      const routeTypes = stopRouteTypes.get(stop_id);
      const modes = routeTypesToModes(routeTypes);
      return {
        stop_id,
        stop_name: String(r.stop_name),
        lat: r.lat as number,
        lon: r.lon as number,
        modes,
        primary_mode: modes.length ? primaryMode(modes) : 'other',
      };
    });
  } finally {
    await conn.close();
  }
}

export async function fetchShapes(feedId: string): Promise<ShapePolyline[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const hasShapes = await tableExists(conn, feedId, 'shapes');
    if (!hasShapes) return [];
    const hasTrips = await tableExists(conn, feedId, 'trips');
    const hasRoutes = await tableExists(conn, feedId, 'routes');

    const shapeRouteTypes = new Map<string, Set<number>>();
    if (hasTrips && hasRoutes) {
      const tr = qualifiedTable(feedId, 'trips.txt');
      const rt = qualifiedTable(feedId, 'routes.txt');
      const res = await conn.query(`
        SELECT DISTINCT t.shape_id AS shape_id,
               TRY_CAST(r.route_type AS INTEGER) AS route_type
        FROM ${tr} t
        JOIN ${rt} r ON t.route_id = r.route_id
        WHERE t.shape_id IS NOT NULL
          AND TRY_CAST(r.route_type AS INTEGER) IS NOT NULL
      `);
      for (const row of res.toArray()) {
        const id = String(row.shape_id);
        const rtVal = row.route_type as number;
        let set = shapeRouteTypes.get(id);
        if (!set) { set = new Set(); shapeRouteTypes.set(id, set); }
        set.add(rtVal);
      }
    }

    const res = await conn.query(`
      SELECT shape_id,
             TRY_CAST(shape_pt_lon AS DOUBLE) AS lon,
             TRY_CAST(shape_pt_lat AS DOUBLE) AS lat,
             TRY_CAST(shape_pt_sequence AS INTEGER) AS seq
      FROM ${qualifiedTable(feedId, 'shapes.txt')}
      WHERE TRY_CAST(shape_pt_lon AS DOUBLE) IS NOT NULL
      ORDER BY shape_id, seq
    `);
    const byId = new Map<string, [number, number][]>();
    for (const r of res.toArray()) {
      const id = String(r.shape_id);
      let arr = byId.get(id);
      if (!arr) { arr = []; byId.set(id, arr); }
      arr.push([r.lon as number, r.lat as number]);
    }
    return [...byId.entries()].map(([shape_id, coords]) => {
      const modes = routeTypesToModes(shapeRouteTypes.get(shape_id));
      return {
        shape_id,
        coords,
        modes,
        primary_mode: modes.length ? primaryMode(modes) : 'other',
      };
    });
  } finally {
    await conn.close();
  }
}

function routeTypesToModes(rts: Set<number> | undefined): Mode[] {
  if (!rts || rts.size === 0) return [];
  const modes = new Set<Mode>();
  for (const rt of rts) modes.add(classifyRouteType(rt));
  return [...modes];
}

async function tableExists(
  conn: Awaited<ReturnType<typeof getConnection>>,
  feedId: string,
  stem: string,
): Promise<boolean> {
  const res = await conn.query(`
    SELECT count(*)::INTEGER AS n
    FROM information_schema.tables
    WHERE table_name = '${feedId}__${stem}'
  `);
  const row = res.toArray()[0] as { n: number };
  return row.n > 0;
}
