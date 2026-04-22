// Name normalization for the Entity Registry.
//
// Goal: collapse the many spellings of the "same" Austrian stop or route across
// years so the spatial/identity matcher can bucket them. We intentionally err on
// the side of *folding more* — two distinct stops at different locations will
// still stay separate because the stop matcher also requires spatial proximity.

const DIACRITIC_RE = /\p{Diacritic}/gu;

// Ordered longest-first so "Hauptbahnhof" is stripped before "Bahnhof".
const STATION_TOKENS: RegExp[] = [
  /\b(hauptbahnhof|hbf)\b/gi,
  /\b(bahnhof|bhf)\b/gi,
  /\b(bahnhst|bst)\b/gi,
  /\b(haltestelle|hst)\b/gi,
  /\bstation\b/gi,
];

// Platform / Steig / Gleis markers. Matches trailing noise like
// " Steig 3", " Gleis 12", "/Stg.4", " Bstg 2", " Kante B".
const PLATFORM_RE =
  /(?:[\s,/-]+)(?:steig|stg\.?|gleis|gl\.?|bahnsteig|bstg\.?|kante|platform|plat\.?|ausgang)[\s._-]*[0-9a-z]+\b/gi;

// Directional / operator qualifier suffixes commonly appended to Austrian
// stop names, e.g. "Wien Hbf (ÖBB)", "Linz/Donau Hbf", "Graz Hbf - Bus".
// We strip trailing parentheticals and hyphenated suffixes conservatively.
const TRAIL_PAREN_RE = /\s*\([^)]*\)\s*$/;

/** Fold German umlauts to their standard ASCII replacements. */
function foldUmlauts(s: string): string {
  return s
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

/**
 * Normalize a stop name for matching purposes.
 *
 * Steps:
 *   1. NFD-decompose + strip combining diacritics (é → e, etc.)
 *   2. Fold German umlauts (ä → ae, ß → ss)
 *   3. Lowercase
 *   4. Strip platform suffixes (Steig 3, Gleis 12, Bstg 2, ...)
 *   5. Remove station-qualifier words (Bahnhof, Hbf, Hst, ...)
 *   6. Strip trailing parentheticals (often operator info)
 *   7. Collapse punctuation and whitespace
 */
export function normalizeStopName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.normalize('NFD').replace(DIACRITIC_RE, '');
  s = foldUmlauts(s).toLowerCase();
  s = s.replace(PLATFORM_RE, ' ');
  for (const rx of STATION_TOKENS) s = s.replace(rx, ' ');
  s = s.replace(TRAIL_PAREN_RE, ' ');
  s = s.replace(/[._/\\,;:"'`()\[\]{}!?*+=<>#]/g, ' ');
  s = s.replace(/\s+-\s+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Normalize a route short name (line number). We keep them mostly as-is but
 * upper-case and strip whitespace so "s 1", "S1 ", "s1" all collapse.
 */
export function normalizeRouteShortName(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = foldUmlauts(raw.normalize('NFD').replace(DIACRITIC_RE, ''))
    .toUpperCase()
    .replace(/\s+/g, '')
    .trim();
  return s;
}

/**
 * Lower-cased, diacritic-folded "freeform" key. Used for agency names and route
 * long names where we want forgiving equality but don't want to drop words.
 */
export function normalizeLoose(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = foldUmlauts(raw.normalize('NFD').replace(DIACRITIC_RE, ''))
    .toLowerCase()
    .replace(/[._/\\,;:"'`()\[\]{}!?*+=<>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}
