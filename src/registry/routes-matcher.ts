// Route matcher for the Entity Registry.
//
// Primary key:   (agencyKey, routeShortNameKey, modeCategory)
// Fallback key:  (agencyKey, routeLongNameKey,  modeCategory)   when short is empty
//
// `agencyKey` is the normalized `agency_name` when available, else the raw
// `agency_id`, else `__none__` (GTFS permits a single-agency feed to omit
// `agency_id` from routes.txt). `modeCategory` is the high-level bucket from
// `gtfs/modes.ts` (rail / metro / tram / bus / other) so a regional rail line
// can stay identified across a `route_type` of 2 → 106 change between feeds.

import { classifyRouteType, type Mode } from '../gtfs/modes';
import { normalizeLoose, normalizeRouteShortName } from './normalize';

export interface RawRoute {
  feedId: string;
  rawId: string;
  agencyId: string | null;
  agencyName: string | null;
  shortName: string | null;
  longName: string | null;
  routeType: number | null;
}

export interface CanonicalRoute {
  canonicalId: string;
  shortName: string;
  longName: string;
  agency: string;
  mode: Mode;
  memberCount: number;
  feedCount: number;
}

export interface RouteMatchResult {
  assignments: Map<string, string>;
  canonicals: Map<string, CanonicalRoute>;
  members: Map<string, RawRoute[]>;
}

function memberKey(r: RawRoute): string {
  return `${r.feedId}\t${r.rawId}`;
}

function agencyKey(r: RawRoute): string {
  const byName = normalizeLoose(r.agencyName);
  if (byName) return `n:${byName}`;
  const byId = (r.agencyId ?? '').trim();
  if (byId) return `i:${byId.toLowerCase()}`;
  return '__none__';
}

function slugPart(s: string): string {
  return s
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .slice(0, 24)
    .toLowerCase();
}

function canonicalIdFor(agency: string, mode: Mode, nameKey: string): string {
  return `r_${slugPart(agency) || 'none'}_${mode}_${slugPart(nameKey) || 'none'}`;
}

export function matchRoutes(routes: RawRoute[]): RouteMatchResult {
  // groupKey -> member indices
  const groups = new Map<string, number[]>();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const mode = classifyRouteType(r.routeType);
    const shortK = normalizeRouteShortName(r.shortName);
    const longK = normalizeLoose(r.longName);
    const nameK = shortK || longK || '__unnamed__';
    const key = `${agencyKey(r)}|${mode}|${nameK}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(i);
  }

  const assignments = new Map<string, string>();
  const canonicals = new Map<string, CanonicalRoute>();
  const members = new Map<string, RawRoute[]>();

  for (const [, idxs] of groups) {
    let bestShort = '', bestLong = '', bestAgency = '';
    let mode: Mode = 'other';
    const feedSet = new Set<string>();
    const memberList: RawRoute[] = [];
    let nameKeyForCid = '';
    for (const i of idxs) {
      const r = routes[i];
      memberList.push(r);
      feedSet.add(r.feedId);
      mode = classifyRouteType(r.routeType);
      if (r.shortName && r.shortName.length > bestShort.length) bestShort = r.shortName;
      if (r.longName && r.longName.length > bestLong.length) bestLong = r.longName;
      if (r.agencyName && r.agencyName.length > bestAgency.length) bestAgency = r.agencyName;
      if (!nameKeyForCid) {
        nameKeyForCid = normalizeRouteShortName(r.shortName) || normalizeLoose(r.longName) || '';
      }
    }
    const ak = agencyKey(memberList[0]);
    const cid = canonicalIdFor(ak, mode, nameKeyForCid);
    canonicals.set(cid, {
      canonicalId: cid,
      shortName: bestShort,
      longName: bestLong,
      agency: bestAgency || (memberList[0].agencyId ?? ''),
      mode,
      memberCount: memberList.length,
      feedCount: feedSet.size,
    });
    members.set(cid, memberList);
    for (const m of memberList) assignments.set(memberKey(m), cid);
  }

  return { assignments, canonicals, members };
}

export function lookupRouteCanonical(
  result: RouteMatchResult,
  feedId: string,
  rawId: string,
): string | null {
  return result.assignments.get(`${feedId}\t${rawId}`) ?? null;
}
