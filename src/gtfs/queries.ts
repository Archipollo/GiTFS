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

/** Row shape for "lines served by this stop" — one row per route. */
export interface LineForStop {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  agency_name: string;
  route_type: number | null;
  mode: Mode;
  /** Number of distinct trips from this route that call at this stop. */
  trip_count: number;
}

/** One stop along a route's representative trip, in real sequence order. */
export interface RouteDirectionStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
}

/**
 * One direction (aka "course") of a route — the stops a rider would actually
 * experience on a typical trip in that direction, in real sequence order.
 *
 * We don't try to be exhaustive with every trip pattern variation here; we
 * pick the longest-pattern representative within each direction, since that's
 * what "show me the line" inspectors in tools like gtfs.pro display.
 */
export interface RouteDirection {
  /** `direction_id` from trips.txt, or null when the column is missing. */
  direction_id: number | null;
  /** `trip_headsign` of the picked representative trip; falls back to "". */
  headsign: string;
  /** How many trips in this direction match the representative's stop pattern. */
  trip_count: number;
  /** Stops in the order the rider would encounter them. */
  stops: RouteDirectionStop[];
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

async function columnExists(
  conn: Awaited<ReturnType<typeof getConnection>>,
  feedId: string,
  stem: string,
  column: string,
): Promise<boolean> {
  const res = await conn.query(`
    SELECT count(*)::INTEGER AS n
    FROM information_schema.columns
    WHERE table_name = '${feedId}__${stem}' AND column_name = '${column}'
  `);
  const row = res.toArray()[0] as { n: number };
  return row.n > 0;
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Routes that call at a given stop, with per-route trip counts. Returns the
 * rows sorted by mode priority then by short name.
 *
 * Requires stop_times, trips, and routes — returns `[]` if any is missing.
 */
export async function fetchLinesForStop(
  feedId: string,
  stopId: string,
): Promise<LineForStop[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const hasStopTimes = await tableExists(conn, feedId, 'stop_times');
    const hasTrips = await tableExists(conn, feedId, 'trips');
    const hasRoutes = await tableExists(conn, feedId, 'routes');
    if (!hasStopTimes || !hasTrips || !hasRoutes) return [];
    const hasAgency = await tableExists(conn, feedId, 'agency');
    const hasAgencyId = await columnExists(conn, feedId, 'routes', 'agency_id');
    const hasShort = await columnExists(conn, feedId, 'routes', 'route_short_name');
    const hasLong = await columnExists(conn, feedId, 'routes', 'route_long_name');

    const st = qualifiedTable(feedId, 'stop_times.txt');
    const tr = qualifiedTable(feedId, 'trips.txt');
    const rt = qualifiedTable(feedId, 'routes.txt');
    const agencyJoin =
      hasAgency && hasAgencyId
        ? `LEFT JOIN ${qualifiedTable(feedId, 'agency.txt')} a ON a.agency_id = r.agency_id`
        : hasAgency
          ? `LEFT JOIN ${qualifiedTable(feedId, 'agency.txt')} a ON TRUE`
          : '';
    const agencyExpr = hasAgency ? 'a.agency_name' : 'NULL';
    const shortExpr = hasShort ? 'r.route_short_name' : 'NULL';
    const longExpr = hasLong ? 'r.route_long_name' : 'NULL';

    const sql = `
      SELECT r.route_id AS route_id,
             ${shortExpr} AS route_short_name,
             ${longExpr}  AS route_long_name,
             ${agencyExpr} AS agency_name,
             TRY_CAST(r.route_type AS INTEGER) AS route_type,
             COUNT(DISTINCT t.trip_id)::INTEGER AS trip_count
      FROM ${st} st
      JOIN ${tr} t ON st.trip_id = t.trip_id
      JOIN ${rt} r ON t.route_id = r.route_id
      ${agencyJoin}
      WHERE st.stop_id = ${sqlStr(stopId)}
      GROUP BY r.route_id, ${shortExpr}, ${longExpr}, ${agencyExpr}, r.route_type
    `;
    const res = await conn.query(sql);
    const rows: LineForStop[] = res.toArray().map((row) => {
      const rtVal = row.route_type as number | null;
      return {
        route_id: String(row.route_id),
        route_short_name: row.route_short_name == null ? '' : String(row.route_short_name),
        route_long_name: row.route_long_name == null ? '' : String(row.route_long_name),
        agency_name: row.agency_name == null ? '' : String(row.agency_name),
        route_type: rtVal,
        mode: classifyRouteType(rtVal),
        trip_count: Number(row.trip_count ?? 0),
      };
    });
    const modeRank: Record<Mode, number> = { rail: 0, metro: 1, tram: 2, bus: 3, other: 4 };
    rows.sort((a, b) => {
      const dm = modeRank[a.mode] - modeRank[b.mode];
      if (dm !== 0) return dm;
      const as = a.route_short_name || a.route_long_name;
      const bs = b.route_short_name || b.route_long_name;
      return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
    });
    return rows;
  } finally {
    await conn.close();
  }
}

/**
 * Directions ("courses") of a route with their stops in real sequence order.
 *
 * Strategy:
 *   1. For each trip on this route, compute its ordered stop-pattern.
 *   2. Group trips by (direction_id, pattern) and pick the longest pattern
 *      per direction as the representative (ties broken by trip count).
 *   3. Expand the representative trip's stop_times back to a sequence.
 *
 * `trip_count` counts only trips that share the representative's pattern,
 * so the displayed list reflects what most riders actually experience in
 * that direction. Feeds without `direction_id` collapse into a single
 * direction with `direction_id: null`.
 */
export async function fetchRouteDirections(
  feedId: string,
  routeId: string,
): Promise<RouteDirection[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const hasStopTimes = await tableExists(conn, feedId, 'stop_times');
    const hasTrips = await tableExists(conn, feedId, 'trips');
    const hasStops = await tableExists(conn, feedId, 'stops');
    if (!hasStopTimes || !hasTrips || !hasStops) return [];
    const hasDir = await columnExists(conn, feedId, 'trips', 'direction_id');
    const hasHeadsign = await columnExists(conn, feedId, 'trips', 'trip_headsign');

    const st = qualifiedTable(feedId, 'stop_times.txt');
    const tr = qualifiedTable(feedId, 'trips.txt');
    const sp = qualifiedTable(feedId, 'stops.txt');

    // DuckDB supports STRING_AGG(... ORDER BY ...) and ROW_NUMBER() OVER ...,
    // so the whole pick-the-best-pattern-per-direction dance fits in one query.
    const dirExpr = hasDir ? 'COALESCE(TRY_CAST(t.direction_id AS INTEGER), -1)' : '-1';
    const headsignExpr = hasHeadsign ? "COALESCE(t.trip_headsign, '')" : "''";

    const sql = `
      WITH trip_patterns AS (
        SELECT
          t.trip_id AS trip_id,
          ${dirExpr} AS dir,
          ${headsignExpr} AS headsign,
          STRING_AGG(st.stop_id, '|' ORDER BY TRY_CAST(st.stop_sequence AS INTEGER)) AS pattern,
          COUNT(*)::INTEGER AS stop_count
        FROM ${tr} t
        JOIN ${st} st ON st.trip_id = t.trip_id
        WHERE t.route_id = ${sqlStr(routeId)}
        GROUP BY t.trip_id, dir, headsign
      ),
      pattern_groups AS (
        SELECT
          dir,
          pattern,
          COUNT(*)::INTEGER AS trip_count,
          MAX(stop_count)::INTEGER AS stop_count,
          ANY_VALUE(trip_id) AS sample_trip_id,
          ANY_VALUE(headsign) AS headsign
        FROM trip_patterns
        GROUP BY dir, pattern
      ),
      ranked AS (
        SELECT
          dir, trip_count, sample_trip_id, headsign,
          ROW_NUMBER() OVER (PARTITION BY dir ORDER BY stop_count DESC, trip_count DESC) AS rnk
        FROM pattern_groups
      ),
      reps AS (
        SELECT dir, trip_count, sample_trip_id, headsign
        FROM ranked
        WHERE rnk = 1
      )
      SELECT
        reps.dir            AS dir,
        reps.trip_count     AS trip_count,
        reps.headsign       AS headsign,
        TRY_CAST(st2.stop_sequence AS INTEGER) AS seq,
        s.stop_id           AS stop_id,
        COALESCE(s.stop_name, '') AS stop_name,
        TRY_CAST(s.stop_lat AS DOUBLE) AS lat,
        TRY_CAST(s.stop_lon AS DOUBLE) AS lon
      FROM reps
      JOIN ${st} st2 ON st2.trip_id = reps.sample_trip_id
      JOIN ${sp} s   ON s.stop_id = st2.stop_id
      ORDER BY reps.dir, seq
    `;
    const res = await conn.query(sql);

    const byDir = new Map<number, RouteDirection>();
    for (const row of res.toArray()) {
      const dir = Number(row.dir);
      let bucket = byDir.get(dir);
      if (!bucket) {
        bucket = {
          direction_id: dir === -1 ? null : dir,
          headsign: row.headsign == null ? '' : String(row.headsign),
          trip_count: Number(row.trip_count ?? 0),
          stops: [],
        };
        byDir.set(dir, bucket);
      }
      const lat = row.lat as number | null;
      const lon = row.lon as number | null;
      if (lat == null || lon == null) continue;
      bucket.stops.push({
        stop_id: String(row.stop_id),
        stop_name: String(row.stop_name),
        lat,
        lon,
        stop_sequence: Number(row.seq ?? 0),
      });
    }

    const directions = [...byDir.values()];
    // If the feed lacks trip_headsign, fall back to the last stop's name so
    // the UI still has something informative to show in the direction badge.
    for (const d of directions) {
      if (!d.headsign && d.stops.length) {
        d.headsign = d.stops[d.stops.length - 1].stop_name;
      }
    }
    // Stable ordering: direction_id 0 before 1, then null last.
    directions.sort((a, b) => {
      if (a.direction_id === b.direction_id) return 0;
      if (a.direction_id === null) return 1;
      if (b.direction_id === null) return -1;
      return a.direction_id - b.direction_id;
    });
    return directions;
  } finally {
    await conn.close();
  }
}

/**
 * Whole-feed shape → route_id[] index. One query, one pass; used by the diff
 * overlay to color every polyline by its route's diff status.
 *
 * The list per shape is sorted most-tripped-first to mirror
 * `resolveShapeToRoutes`, which matters when a shape is shared between
 * routes and we have to pick a canonical owner.
 */
export async function fetchShapeRouteMap(
  feedId: string,
): Promise<Map<string, string[]>> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    if (!(await tableExists(conn, feedId, 'trips'))) return new Map();
    const hasShapeCol = await columnExists(conn, feedId, 'trips', 'shape_id');
    if (!hasShapeCol) return new Map();
    const tr = qualifiedTable(feedId, 'trips.txt');
    const res = await conn.query(`
      SELECT shape_id, route_id, COUNT(*)::INTEGER AS n
      FROM ${tr}
      WHERE shape_id IS NOT NULL
      GROUP BY shape_id, route_id
      ORDER BY shape_id, n DESC
    `);
    const out = new Map<string, string[]>();
    for (const row of res.toArray()) {
      const shapeId = row.shape_id == null ? '' : String(row.shape_id);
      if (!shapeId) continue;
      const routeId = String(row.route_id);
      let arr = out.get(shapeId);
      if (!arr) {
        arr = [];
        out.set(shapeId, arr);
      }
      arr.push(routeId);
    }
    return out;
  } finally {
    await conn.close();
  }
}

/**
 * Which route_ids does a given shape_id belong to? Most feeds have one route
 * per shape, but VOR's generated shapes are occasionally shared. Ordered so
 * the most-tripped route comes first — a reasonable "pick one" default.
 */
export async function resolveShapeToRoutes(
  feedId: string,
  shapeId: string,
): Promise<string[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    if (!(await tableExists(conn, feedId, 'trips'))) return [];
    const hasShapeCol = await columnExists(conn, feedId, 'trips', 'shape_id');
    if (!hasShapeCol) return [];
    const tr = qualifiedTable(feedId, 'trips.txt');
    const res = await conn.query(`
      SELECT route_id, COUNT(*)::INTEGER AS n
      FROM ${tr}
      WHERE shape_id = ${sqlStr(shapeId)}
      GROUP BY route_id
      ORDER BY n DESC
    `);
    return res.toArray().map((r) => String(r.route_id));
  } finally {
    await conn.close();
  }
}

/**
 * Basic metadata for a list of route_ids. Returns the same `LineForStop`
 * shape as `fetchLinesForStop` so callers can reuse `LinePill` directly.
 * `trip_count` is the total trips for each route (not stop-specific).
 */
export async function fetchRouteMetas(
  feedId: string,
  routeIds: string[],
): Promise<LineForStop[]> {
  if (routeIds.length === 0) return [];
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const hasRoutes = await tableExists(conn, feedId, 'routes');
    const hasTrips = await tableExists(conn, feedId, 'trips');
    if (!hasRoutes) return [];
    const hasAgency = await tableExists(conn, feedId, 'agency');
    const hasAgencyId = await columnExists(conn, feedId, 'routes', 'agency_id');
    const hasShort = await columnExists(conn, feedId, 'routes', 'route_short_name');
    const hasLong = await columnExists(conn, feedId, 'routes', 'route_long_name');

    const rt = qualifiedTable(feedId, 'routes.txt');
    const agencyJoin =
      hasAgency && hasAgencyId
        ? `LEFT JOIN ${qualifiedTable(feedId, 'agency.txt')} a ON a.agency_id = r.agency_id`
        : hasAgency
          ? `LEFT JOIN ${qualifiedTable(feedId, 'agency.txt')} a ON TRUE`
          : '';
    const agencyExpr = hasAgency ? 'a.agency_name' : 'NULL';
    const shortExpr = hasShort ? 'r.route_short_name' : 'NULL';
    const longExpr = hasLong ? 'r.route_long_name' : 'NULL';

    const tripCountExpr = hasTrips
      ? `(SELECT COUNT(*)::INTEGER FROM ${qualifiedTable(feedId, 'trips.txt')} t WHERE t.route_id = r.route_id)`
      : '0';

    const inList = routeIds.map((id) => sqlStr(id)).join(', ');
    const sql = `
      SELECT r.route_id AS route_id,
             ${shortExpr} AS route_short_name,
             ${longExpr}  AS route_long_name,
             ${agencyExpr} AS agency_name,
             TRY_CAST(r.route_type AS INTEGER) AS route_type,
             ${tripCountExpr} AS trip_count
      FROM ${rt} r
      ${agencyJoin}
      WHERE r.route_id IN (${inList})
    `;
    const res = await conn.query(sql);
    const rows: LineForStop[] = res.toArray().map((row) => {
      const rtVal = row.route_type as number | null;
      return {
        route_id: String(row.route_id),
        route_short_name: row.route_short_name == null ? '' : String(row.route_short_name),
        route_long_name: row.route_long_name == null ? '' : String(row.route_long_name),
        agency_name: row.agency_name == null ? '' : String(row.agency_name),
        route_type: rtVal,
        mode: classifyRouteType(rtVal),
        trip_count: Number(row.trip_count ?? 0),
      };
    });
    const modeRank: Record<Mode, number> = { rail: 0, metro: 1, tram: 2, bus: 3, other: 4 };
    rows.sort((a, b) => {
      const dm = modeRank[a.mode] - modeRank[b.mode];
      if (dm !== 0) return dm;
      const as = a.route_short_name || a.route_long_name;
      const bs = b.route_short_name || b.route_long_name;
      return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
    });
    return rows;
  } finally {
    await conn.close();
  }
}
