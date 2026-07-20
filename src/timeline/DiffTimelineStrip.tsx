import { useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { yearOfFeed, feedYearsOf, feedYearLabels, pickFeedForYear, type FeedYear } from './math';

/**
 * Basemap year slider for diff mode.
 *
 * Scrubs the Wayback satellite imagery independently of the A/B diff pair —
 * the diff result is never affected. Useful for checking whether a new or
 * removed segment already existed in a different satellite vintage.
 */
export function DiffTimelineStrip() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const diffBasemapYear = useAppStore((s) => s.diffBasemapYear);
  const setDiffBasemapYear = useAppStore((s) => s.setDiffBasemapYear);
  const historicalBasemap = useAppStore((s) => s.historicalBasemap);

  // Every loaded feed, sorted chronologically — same helper as TimelineStrip.
  const feedYears: FeedYear[] = useMemo(
    () => feedYearsOf(feedOrder, feeds),
    [feedOrder, feeds],
  );

  // Only the single-map network overview has one satellite layer to scrub.
  // Timeline drives its own year; the split panes are each pinned to the era
  // of the feed they draw, so a shared scrubber would be meaningless there.
  if (diffOverviewLayout !== 'single') return null;
  if (diffViewMode !== 'overview') return null;
  if (!historicalBasemap) return null;
  if (feedYears.length < 2) return null;

  // null = follow feed A's year, matching MapView's behavior.
  const feedAMeta = activeFeedId ? feeds[activeFeedId] : null;
  const feedAYear = feedAMeta ? yearOfFeed(feedAMeta).year : null;
  const activeYear = diffBasemapYear ?? feedAYear ?? feedYears[feedYears.length - 1].year;
  // Use pickFeedForYear to resolve exact-year matches and clamp to the nearest
  // available year when activeYear falls between feed years.
  const picked = pickFeedForYear(feedYears, activeYear, feeds);
  const clampedIndex = picked
    ? feedYears.findIndex((y) => y.feedId === picked.feedId)
    : feedYears.length - 1;
  const labels = feedYearLabels(feedYears);

  return (
    <div
      className="diff-timeline-strip"
      role="region"
      aria-label="Basemap year selector"
    >
      <span className="muted" aria-hidden><i className="fa-solid fa-satellite" /></span>
      <span className="muted" aria-hidden>{labels[0]}</span>
      <input
        type="range"
        className="timeline-slider"
        min={0}
        max={feedYears.length - 1}
        step={1}
        value={clampedIndex}
        onChange={(e) => {
          const i = Number(e.target.value);
          setDiffBasemapYear(feedYears[i].year);
        }}
        aria-label="Select basemap year"
      />
      <span className="muted" aria-hidden>{labels[labels.length - 1]}</span>
      <span className="timeline-current-year">{labels[clampedIndex]}</span>
    </div>
  );
}
