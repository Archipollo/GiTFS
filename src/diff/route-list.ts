// Display-only bucketing of routes for the line-list sidebar. Reclassifies
// `RouteDiffEntry.status` (route *identity*) against geometry-change info
// (`routesWithGeomChange`, from `useDiffedShapes`) into the four buckets the
// line list filters by. Does not touch `RouteStatus`/`engine.ts` — this is
// purely a UI-facing view of the same diff result.

import type { RouteDiffEntry } from './engine';

export type LineListStatus = 'added' | 'removed' | 'rerouted' | 'unchanged';

export interface LineListRow {
  canonicalId: string;
  shortName: string;
  longName: string;
  mode: RouteDiffEntry['canonical']['mode'];
  status: LineListStatus;
}

function sideName(entry: RouteDiffEntry): { shortName: string; longName: string } {
  const side = entry.b ?? entry.a;
  return { shortName: side?.shortName ?? '', longName: side?.longName ?? '' };
}

/**
 * Transit-line ordering: digit-prefixed names first, numerically ("1, 2, 11,
 * 101" rather than lexicographic "1, 101, 11, 2"), with letter suffixes
 * trailing their base number ("45" then "45a"). Names *starting* with a letter
 * ("N82") form a second bucket after every numbered line — the explicit bucket
 * split is what keeps them there, since locale collation alone would interleave.
 */
function compareShortName(a: string, b: string): number {
  const aNum = /^\d/.test(a);
  const bNum = /^\d/.test(b);
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function deriveLineListRows(
  routes: readonly RouteDiffEntry[],
  routesWithGeomChange: ReadonlySet<string> | null,
): LineListRow[] {
  const rows = routes.map((entry) => {
    const { shortName, longName } = sideName(entry);
    let status: LineListStatus;
    if (entry.status === 'added') status = 'added';
    else if (entry.status === 'removed') status = 'removed';
    else if (routesWithGeomChange?.has(entry.canonicalId)) status = 'rerouted';
    else status = 'unchanged';
    return { canonicalId: entry.canonicalId, shortName, longName, mode: entry.canonical.mode, status };
  });
  return rows.sort(
    (a, b) => compareShortName(a.shortName, b.shortName) || a.longName.localeCompare(b.longName, 'en'),
  );
}
