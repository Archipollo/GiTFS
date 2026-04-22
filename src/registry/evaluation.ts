// Evaluation harness for the Entity Registry.
//
// Given a hand-labeled truth set of pairs (do entity A in feed X and entity B
// in feed Y refer to the *same* real-world entity?), compute precision, recall,
// and F1 of the registry's automatic matches.

import type { RegistrySnapshot } from './registry';

export type PairKind = 'stop' | 'route';

export interface TruthPair {
  feedA: string;
  rawA: string;
  feedB: string;
  rawB: string;
  same: boolean;
}

export interface TruthSet {
  kind: PairKind;
  pairs: TruthPair[];
}

export interface EvaluationResult {
  kind: PairKind;
  total: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  /** Pairs we couldn't evaluate because an entity is not in the registry. */
  unknown: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  mistakes: Array<{
    pair: TruthPair;
    predicted: boolean;
    canonicalA: string | null;
    canonicalB: string | null;
  }>;
}

function lookup(
  kind: PairKind,
  snap: RegistrySnapshot,
  feedId: string,
  rawId: string,
): string | null {
  const key = `${feedId}\t${rawId}`;
  if (kind === 'stop') return snap.stopAssignments[key] ?? null;
  return snap.routeAssignments[key] ?? null;
}

export function evaluate(snap: RegistrySnapshot, truth: TruthSet): EvaluationResult {
  let tp = 0, fp = 0, tn = 0, fn = 0, unknown = 0;
  const mistakes: EvaluationResult['mistakes'] = [];
  for (const pair of truth.pairs) {
    const a = lookup(truth.kind, snap, pair.feedA, pair.rawA);
    const b = lookup(truth.kind, snap, pair.feedB, pair.rawB);
    if (a == null || b == null) {
      unknown += 1;
      continue;
    }
    const predicted = a === b;
    if (predicted && pair.same) tp += 1;
    else if (predicted && !pair.same) { fp += 1; mistakes.push({ pair, predicted, canonicalA: a, canonicalB: b }); }
    else if (!predicted && pair.same) { fn += 1; mistakes.push({ pair, predicted, canonicalA: a, canonicalB: b }); }
    else tn += 1;
  }
  const precDen = tp + fp;
  const recDen = tp + fn;
  const precision = precDen === 0 ? 0 : tp / precDen;
  const recall = recDen === 0 ? 0 : tp / recDen;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const total = tp + fp + tn + fn;
  const accuracy = total === 0 ? 0 : (tp + tn) / total;
  return {
    kind: truth.kind,
    total,
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    unknown,
    precision,
    recall,
    f1,
    accuracy,
    mistakes,
  };
}

/**
 * Parse a truth-set file. Accepts either:
 *   - the canonical JSON shape `{ "kind": "stop", "pairs": [{...}, ...] }`
 *   - a CSV with header `kind,feedA,rawA,feedB,rawB,same` where `kind` is
 *     constant across all rows.
 */
export function parseTruthSet(text: string, filename?: string): TruthSet {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonTruth(trimmed);
  }
  if (filename?.toLowerCase().endsWith('.csv') || trimmed.includes(',')) {
    return parseCsvTruth(trimmed);
  }
  return parseJsonTruth(trimmed);
}

function parseJsonTruth(text: string): TruthSet {
  const data = JSON.parse(text) as Partial<TruthSet> | TruthPair[];
  if (Array.isArray(data)) {
    throw new Error('Truth file must be an object with { kind, pairs }');
  }
  if (!data.kind || !Array.isArray(data.pairs)) {
    throw new Error('Truth file missing "kind" or "pairs"');
  }
  const kind = data.kind;
  if (kind !== 'stop' && kind !== 'route') {
    throw new Error(`Unsupported truth kind: ${String(kind)}`);
  }
  return {
    kind,
    pairs: data.pairs.map((p) => ({
      feedA: String(p.feedA),
      rawA: String(p.rawA),
      feedB: String(p.feedB),
      rawB: String(p.rawB),
      same: Boolean(p.same),
    })),
  };
}

function parseCsvTruth(text: string): TruthSet {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV truth file has no rows');
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = (k: string) => header.indexOf(k);
  const cKind = idx('kind');
  const cFa = idx('feedA');
  const cRa = idx('rawA');
  const cFb = idx('feedB');
  const cRb = idx('rawB');
  const cSame = idx('same');
  if (cFa < 0 || cRa < 0 || cFb < 0 || cRb < 0 || cSame < 0) {
    throw new Error('CSV truth file must have columns feedA,rawA,feedB,rawB,same (and optionally kind)');
  }
  const pairs: TruthPair[] = [];
  let kind: PairKind | null = null;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]);
    const rowKind = cKind >= 0 ? (cols[cKind]?.trim() as PairKind | undefined) : undefined;
    if (rowKind) {
      if (rowKind !== 'stop' && rowKind !== 'route') throw new Error(`Unsupported kind ${rowKind}`);
      kind = kind ?? rowKind;
      if (kind !== rowKind) throw new Error('Mixed kinds in a single CSV are not supported');
    }
    pairs.push({
      feedA: cols[cFa],
      rawA: cols[cRa],
      feedB: cols[cFb],
      rawB: cols[cRb],
      same: /^(1|true|yes|y|t)$/i.test((cols[cSame] ?? '').trim()),
    });
  }
  return { kind: kind ?? 'stop', pairs };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}
