// Reduces a full IR-level diff (plus its frequency companion) into the
// "what changed since baseline" narrative the Timeline view surfaces.
//
// The counts come straight from `diffFeeds`/`getOrComputeFrequencyDiff` —
// this module does no matching of its own, only summarization + prose.

import type { DiffResult, StopStatus, RouteStatus } from '../diff/engine';
import { filterFrequencyDiff, type FrequencyDiffResult } from '../diff/frequency';
import type { FeedMeta } from '../state/app-store';
import { formatGtfsDate } from './math';

export interface ServiceSpan {
  start: string | null;
  end: string | null;
}

export interface TimelineChangeSummary {
  baselineFeedId: string;
  currentFeedId: string;
  stopCounts: Record<StopStatus, number>;
  /**
   * Net added/removed — stops whose presence actually differs between
   * baseline and current (a stop added then later removed nets to zero
   * here), independent of `stopCounts` which may reflect gross churn in
   * cumulative mode. Lets the UI show "20 added, 15 net added" so a
   * same-period add+remove round-trip doesn't read as invisible.
   */
  netStopCounts: { added: number; removed: number };
  routeCounts: Record<RouteStatus, number>;
  tripCountDelta: number | null;
  serviceSpanBaseline: ServiceSpan;
  serviceSpanCurrent: ServiceSpan;
  /** True until the frequency diff has resolved; gain/loss counts are 0 until then. */
  frequencyPending: boolean;
  frequencyGainRouteCount: number;
  frequencyLossRouteCount: number;
  narrative: string[];
}

function spanOf(meta: FeedMeta): ServiceSpan {
  return { start: formatGtfsDate(meta.feedStartDate), end: formatGtfsDate(meta.feedEndDate) };
}

export function buildTimelineChangeSummary(
  diff: DiffResult,
  freq: FrequencyDiffResult | null,
  baselineMeta: FeedMeta,
  currentMeta: FeedMeta,
  /**
   * In cumulative mode, added/removed should reflect the union of every
   * per-year add/remove event since baseline (churn included), not the net
   * baseline-vs-current diff — a stop added then later removed must still
   * count as a removal instead of netting out to nothing.
   */
  cumulativeStopOverride?: { added: number; removed: number },
): TimelineChangeSummary {
  const netStopCounts = { added: diff.summary.stops.added, removed: diff.summary.stops.removed };
  const stopCounts = cumulativeStopOverride
    ? { ...diff.summary.stops, added: cumulativeStopOverride.added, removed: cumulativeStopOverride.removed }
    : diff.summary.stops;
  const routeCounts = diff.summary.routes;

  const tripCountDelta =
    currentMeta.tripCount != null && baselineMeta.tripCount != null
      ? currentMeta.tripCount - baselineMeta.tripCount
      : null;

  const serviceSpanBaseline = spanOf(baselineMeta);
  const serviceSpanCurrent = spanOf(currentMeta);

  let frequencyGainRouteCount = 0;
  let frequencyLossRouteCount = 0;
  if (freq) {
    const filtered = filterFrequencyDiff(freq, false);
    for (const e of filtered.entries) {
      if (e.delta > 0) frequencyGainRouteCount += 1;
      else if (e.delta < 0) frequencyLossRouteCount += 1;
    }
  }

  const narrative: string[] = [];

  if (stopCounts.added > 0 || stopCounts.removed > 0) {
    const netDiffers = cumulativeStopOverride != null
      && (netStopCounts.added !== stopCounts.added || netStopCounts.removed !== stopCounts.removed);
    narrative.push(
      `${stopCounts.added} stops added, ${stopCounts.removed} removed since baseline`
      + (netDiffers ? ` (${netStopCounts.added} net added, ${netStopCounts.removed} net removed).` : '.'),
    );
  }
  if (stopCounts.moved > 0 || stopCounts.renamed > 0) {
    narrative.push(`${stopCounts.moved} stops relocated, ${stopCounts.renamed} renamed.`);
  }
  if (routeCounts.added > 0 || routeCounts.removed > 0 || routeCounts.renumbered > 0) {
    narrative.push(
      `${routeCounts.added} new routes, ${routeCounts.removed} discontinued, ${routeCounts.renumbered} renumbered.`,
    );
  }
  if (!freq) {
    // frequency stage still pending — no sentence yet, avoids a false "no change" read.
  } else if (frequencyGainRouteCount > 0 || frequencyLossRouteCount > 0) {
    narrative.push(`${frequencyGainRouteCount} routes gained frequency, ${frequencyLossRouteCount} lost service.`);
  }
  if (tripCountDelta != null && tripCountDelta !== 0) {
    narrative.push(
      `${Math.abs(tripCountDelta)} ${tripCountDelta >= 0 ? 'more' : 'fewer'} scheduled trips overall.`,
    );
  }
  if (
    serviceSpanBaseline.start &&
    serviceSpanBaseline.end &&
    serviceSpanCurrent.start &&
    serviceSpanCurrent.end &&
    (serviceSpanBaseline.start !== serviceSpanCurrent.start || serviceSpanBaseline.end !== serviceSpanCurrent.end)
  ) {
    narrative.push(
      `Service window: ${serviceSpanBaseline.start} → ${serviceSpanBaseline.end} to ${serviceSpanCurrent.start} → ${serviceSpanCurrent.end}.`,
    );
  }

  if (narrative.length === 0 && freq) {
    narrative.push('No changes detected since baseline.');
  }

  return {
    baselineFeedId: diff.feedA,
    currentFeedId: diff.feedB,
    stopCounts,
    netStopCounts,
    routeCounts,
    tripCountDelta,
    serviceSpanBaseline,
    serviceSpanCurrent,
    frequencyPending: !freq,
    frequencyGainRouteCount,
    frequencyLossRouteCount,
    narrative,
  };
}
