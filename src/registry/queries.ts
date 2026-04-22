// DuckDB helpers for the Entity Registry.
//
// Unlike `gtfs/queries.ts` (which produces map-ready GeoJSON) these functions
// return the *raw* rows needed by the matchers: stop coordinates/names per
// feed and route metadata joined with agency info.

import { getConnection } from '../gtfs/duckdb';
import { qualifiedTable } from '../gtfs/ingest';
import { ensureFeedTablesLoaded } from '../gtfs/feed-loader';
import type { RawStop } from './stops-matcher';
import type { RawRoute } from './routes-matcher';

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

export async function fetchRawStops(feedId: string): Promise<RawStop[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    const stops = qualifiedTable(feedId, 'stops.txt');
    const res = await conn.query(`
      SELECT stop_id,
             COALESCE(stop_name, '') AS stop_name,
             TRY_CAST(stop_lat AS DOUBLE) AS lat,
             TRY_CAST(stop_lon AS DOUBLE) AS lon
      FROM ${stops}
      WHERE TRY_CAST(stop_lat AS DOUBLE) IS NOT NULL
        AND TRY_CAST(stop_lon AS DOUBLE) IS NOT NULL
    `);
    return res.toArray().map((r) => ({
      feedId,
      rawId: String(r.stop_id),
      name: String(r.stop_name),
      lat: r.lat as number,
      lon: r.lon as number,
    }));
  } finally {
    await conn.close();
  }
}

export async function fetchRawRoutes(feedId: string): Promise<RawRoute[]> {
  await ensureFeedTablesLoaded(feedId);
  const conn = await getConnection();
  try {
    if (!(await tableExists(conn, feedId, 'routes'))) return [];
    const routes = qualifiedTable(feedId, 'routes.txt');
    const hasAgency = await tableExists(conn, feedId, 'agency');
    const hasShort = await columnExists(conn, feedId, 'routes', 'route_short_name');
    const hasLong = await columnExists(conn, feedId, 'routes', 'route_long_name');
    const hasAgencyId = await columnExists(conn, feedId, 'routes', 'agency_id');

    const shortExpr = hasShort ? 'route_short_name' : `NULL`;
    const longExpr = hasLong ? 'route_long_name' : `NULL`;
    const agencyIdExpr = hasAgencyId ? 'agency_id' : `NULL`;

    let sql: string;
    if (hasAgency && hasAgencyId) {
      const agency = qualifiedTable(feedId, 'agency.txt');
      sql = `
        SELECT r.route_id AS route_id,
               ${shortExpr} AS route_short_name,
               ${longExpr}  AS route_long_name,
               r.${agencyIdExpr} AS agency_id,
               a.agency_name AS agency_name,
               TRY_CAST(r.route_type AS INTEGER) AS route_type
        FROM ${routes} r
        LEFT JOIN ${agency} a ON a.agency_id = r.agency_id
      `;
    } else if (hasAgency) {
      // Single-agency feed — pick the only agency row.
      const agency = qualifiedTable(feedId, 'agency.txt');
      sql = `
        SELECT r.route_id AS route_id,
               ${shortExpr} AS route_short_name,
               ${longExpr}  AS route_long_name,
               ${agencyIdExpr} AS agency_id,
               (SELECT agency_name FROM ${agency} LIMIT 1) AS agency_name,
               TRY_CAST(r.route_type AS INTEGER) AS route_type
        FROM ${routes} r
      `;
    } else {
      sql = `
        SELECT r.route_id AS route_id,
               ${shortExpr} AS route_short_name,
               ${longExpr}  AS route_long_name,
               ${agencyIdExpr} AS agency_id,
               NULL AS agency_name,
               TRY_CAST(r.route_type AS INTEGER) AS route_type
        FROM ${routes} r
      `;
    }

    const res = await conn.query(sql);
    return res.toArray().map((row) => ({
      feedId,
      rawId: String(row.route_id),
      agencyId: row.agency_id == null ? null : String(row.agency_id),
      agencyName: row.agency_name == null ? null : String(row.agency_name),
      shortName: row.route_short_name == null ? null : String(row.route_short_name),
      longName: row.route_long_name == null ? null : String(row.route_long_name),
      routeType: row.route_type as number | null,
    }));
  } finally {
    await conn.close();
  }
}
