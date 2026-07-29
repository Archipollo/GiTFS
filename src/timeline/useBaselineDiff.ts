// "What's changed since baseline?" for the Timeline view — a thin
// composition over the same diff engine the A/B diff mode uses
// (`useDiff` + `getOrComputeFrequencyDiff`), reduced into a
// `TimelineChangeSummary` via `buildTimelineChangeSummary`.
//
// Baseline = feedA ("before"), the currently scrubbed feed = feedB
// ("after") — matches the existing "added since baseline" semantics.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/app-store';
import { useDiff } from '../diff/useDiff';
import { getOrComputeDiff } from '../diff/service';
import { getOrComputeFrequencyDiff, type FrequencyDiffResult } from '../diff/frequency';
import type { DiffResult } from '../diff/engine';
import { getRegistry } from '../registry/registry';
import { buildTimelineChangeSummary, type TimelineChangeSummary } from './timelineDiffSummary';
import { feedYearsOf } from './math';
import { computeRouteKmDelta, type RouteKmDelta } from './timelineRouteKm';
import { computeTimelineReroutes } from './timelineReroutes';

export type BaselineDiffStatus =
  | { kind: 'idle' }
  | { kind: 'no-registry' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      summary: TimelineChangeSummary;
      diffResult: DiffResult;
      /** Whether this diff is baseline→current ('cumulative') or previous-year→current ('step'). */
      cumulative: boolean;
      addedStops: GeoJSON.FeatureCollection;
      removedStops: GeoJSON.FeatureCollection;
      addedStopCount: number;
      removedStopCount: number;
      addedRouteCount: number;
      removedRouteCount: number;
      routeKm: RouteKmDelta | null;
      routeKmPending: boolean;
      reroutedRouteCount: number | null;
      reroutedGeojson: GeoJSON.FeatureCollection;
      reroutedPending: boolean;
    };

function stopsToGeoJSON(diff: DiffResult, status: 'added' | 'removed'): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const s of diff.stops) {
    if (s.status !== status) continue;
    const side = status === 'added' ? s.b : s.a;
    if (!side) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [side.lon, side.lat] },
      properties: { name: side.name },
    });
  }
  return { type: 'FeatureCollection', features };
}

function emptyReroutedFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function canonicalIdsToGeoJSON(ids: Set<string>): GeoJSON.FeatureCollection {
  const registry = getRegistry();
  const features: GeoJSON.Feature[] = [];
  if (registry) {
    for (const id of ids) {
      const canon = registry.stops[id];
      if (!canon) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [canon.lon, canon.lat] },
        properties: { name: canon.name },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Union every stop-add/stop-remove event across the whole baseline→current
 * chain (one step diff per consecutive feed-year), instead of just the net
 * baseline-vs-current diff. This is what makes "cumulative" mean "keep
 * collecting changes as you scrub forward" rather than "net out reversals" —
 * a stop added in year 2 and later removed in year 4 should stay flagged in
 * both the growth and loss sets, not disappear once it nets to zero.
 */
async function computeCumulativeStopSets(
  chain: string[],
): Promise<{ added: Set<string>; removed: Set<string> }> {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (let i = 0; i < chain.length - 1; i++) {
    const stepDiff = await getOrComputeDiff(chain[i], chain[i + 1]);
    for (const s of stepDiff.stops) {
      if (s.status === 'added') added.add(s.canonicalId);
      else if (s.status === 'removed') removed.add(s.canonicalId);
    }
  }
  return { added, removed };
}

export function useBaselineDiff(): BaselineDiffStatus {
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const timelineCumulativeMode = useAppStore((s) => s.timelineCumulativeMode);
  const timelineNetChangesMode = useAppStore((s) => s.timelineNetChangesMode);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);

  // Cumulative: compare against the baseline feed. Step: compare against the
  // feed-year immediately before the current one (falls back to baseline at
  // or before the first year, where there's no "previous" to step from).
  const compareFromFeedId = useMemo(() => {
    if (timelineCumulativeMode) return feedASelection;
    const feedYears = feedYearsOf(feedOrder, feeds);
    const idx = feedYears.findIndex((y) => y.feedId === activeFeedId);
    if (idx <= 0) return feedASelection;
    return feedYears[idx - 1].feedId;
  }, [timelineCumulativeMode, feedASelection, feedOrder, feeds, activeFeedId]);

  const diff = useDiff(compareFromFeedId, activeFeedId);

  const [freq, setFreq] = useState<FrequencyDiffResult | null>(null);
  const [routeKm, setRouteKm] = useState<RouteKmDelta | null>(null);
  const [routeKmPending, setRouteKmPending] = useState(false);
  const [reroutedRouteCount, setReroutedRouteCount] = useState<number | null>(null);
  const [reroutedGeojson, setReroutedGeojson] = useState<GeoJSON.FeatureCollection>(emptyReroutedFC);
  const [reroutedPending, setReroutedPending] = useState(false);
  const reqRef = useRef(0);
  const readyResult = diff.kind === 'ready' ? diff.result : null;

  // Chronological chain of feed ids from baseline to the active feed —
  // only meaningful (and only built) in cumulative mode, and only when the
  // active feed is at or after the baseline.
  const cumulativeChain = useMemo(() => {
    if (!timelineCumulativeMode || !feedASelection || !activeFeedId) return null;
    const feedYears = feedYearsOf(feedOrder, feeds);
    const baseIdx = feedYears.findIndex((y) => y.feedId === feedASelection);
    const curIdx = feedYears.findIndex((y) => y.feedId === activeFeedId);
    if (baseIdx < 0 || curIdx < 0 || curIdx < baseIdx) return null;
    return feedYears.slice(baseIdx, curIdx + 1).map((y) => y.feedId);
  }, [timelineCumulativeMode, feedASelection, activeFeedId, feedOrder, feeds]);

  const [cumulativeStops, setCumulativeStops] = useState<{
    added: Set<string>;
    removed: Set<string>;
  } | null>(null);
  const cumReqRef = useRef(0);
  const chainKey = cumulativeChain ? cumulativeChain.join('') : null;

  useEffect(() => {
    if (!cumulativeChain || cumulativeChain.length < 2) {
      setCumulativeStops(cumulativeChain ? { added: new Set(), removed: new Set() } : null);
      return;
    }
    cumReqRef.current += 1;
    const myReq = cumReqRef.current;
    computeCumulativeStopSets(cumulativeChain)
      .then((result) => {
        if (myReq === cumReqRef.current) setCumulativeStops(result);
      })
      .catch((err) => {
        console.warn('[timeline] cumulative stop-change chain failed', err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey]);

  useEffect(() => {
    if (!readyResult) {
      setFreq(null);
      setRouteKm(null);
      setRouteKmPending(false);
      setReroutedRouteCount(null);
      setReroutedGeojson(emptyReroutedFC());
      setReroutedPending(false);
      return;
    }
    reqRef.current += 1;
    const myReq = reqRef.current;
    setFreq(null);
    setRouteKm(null);
    setRouteKmPending(true);
    setReroutedRouteCount(null);
    setReroutedGeojson(emptyReroutedFC());
    setReroutedPending(true);
    getOrComputeFrequencyDiff(readyResult)
      .then((result) => {
        if (myReq === reqRef.current) setFreq(result);
      })
      .catch((err) => {
        console.warn('[timeline] frequency diff failed', err);
      });
    computeRouteKmDelta(readyResult)
      .then((result) => {
        if (myReq === reqRef.current) {
          setRouteKm(result);
          setRouteKmPending(false);
        }
      })
      .catch((err) => {
        console.warn('[timeline] route-km diff failed', err);
        if (myReq === reqRef.current) setRouteKmPending(false);
      });
    computeTimelineReroutes(readyResult)
      .then((result) => {
        if (myReq === reqRef.current) {
          setReroutedRouteCount(result.reroutedRouteCount);
          setReroutedGeojson(result.geojson);
          setReroutedPending(false);
        }
      })
      .catch((err) => {
        console.warn('[timeline] reroute diff failed', err);
        if (myReq === reqRef.current) setReroutedPending(false);
      });
  }, [readyResult]);

  if (diff.kind === 'idle') return { kind: 'idle' };
  if (diff.kind === 'no-registry') return { kind: 'no-registry' };
  if (diff.kind === 'loading') return { kind: 'loading' };
  if (diff.kind === 'error') return { kind: 'error', message: diff.message };

  const baselineMeta = feeds[diff.feedA];
  const currentMeta = feeds[diff.feedB];
  if (!baselineMeta || !currentMeta) return { kind: 'loading' };

  // Cumulative mode has two readings: "net" (default) shows what actually
  // differs between baseline and current — reversals (added then later
  // removed) cancel out, matching what's really on the ground today. "Gross"
  // (churn) shows every add/remove event across the chain, reversals
  // included, for auditing/data-quality use. Step mode has no distinction:
  // a single year-over-year diff is already its own "net".
  const useChurn = timelineCumulativeMode && !timelineNetChangesMode;
  const cumulativeStopOverride =
    useChurn && cumulativeStops
      ? { added: cumulativeStops.added.size, removed: cumulativeStops.removed.size }
      : undefined;
  const summary = buildTimelineChangeSummary(diff.result, freq, baselineMeta, currentMeta, cumulativeStopOverride);
  const addedStops = useChurn && cumulativeStops
    ? canonicalIdsToGeoJSON(cumulativeStops.added)
    : stopsToGeoJSON(diff.result, 'added');
  const removedStops = useChurn && cumulativeStops
    ? canonicalIdsToGeoJSON(cumulativeStops.removed)
    : stopsToGeoJSON(diff.result, 'removed');
  return {
    kind: 'ready',
    summary,
    diffResult: diff.result,
    cumulative: timelineCumulativeMode,
    addedStops,
    removedStops,
    addedStopCount: summary.stopCounts.added,
    removedStopCount: summary.stopCounts.removed,
    addedRouteCount: summary.routeCounts.added,
    removedRouteCount: summary.routeCounts.removed,
    routeKm,
    routeKmPending,
    reroutedRouteCount,
    reroutedGeojson,
    reroutedPending,
  };
}
