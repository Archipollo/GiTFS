import { useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { yearOfFeed, pickFeedForYear, type FeedYear } from './math';

/**
 * Basemap year slider for diff mode.
 *
 * Scrubs the Wayback satellite imagery independently of the A/B diff pair —
 * the diff result is never affected. Useful for checking whether a new or
 * removed segment already existed in a different satellite vintage.
 */
export function DiffTimelineStrip() {
  const mode = useAppStore((s) => s.mode);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const diffBasemapYear = useAppStore((s) => s.diffBasemapYear);
  const setDiffBasemapYear = useAppStore((s) => s.setDiffBasemapYear);
  const historicalBasemap = useAppStore((s) => s.historicalBasemap);

  // Unique, sorted feed-years — same dedup logic as TimelineStrip.
  const feedYears: FeedYear[] = useMemo(() => {
    const all = feedOrder
      .map((id) => feeds[id])
      .filter(Boolean)
      .map(yearOfFeed);
    const byYear = new Map<number, FeedYear>();
    for (const y of all) {
      const prev = byYear.get(y.year);
      const prevLoaded = prev ? feeds[prev.feedId]?.loadedAt ?? 0 : -1;
      const curLoaded = feeds[y.feedId]?.loadedAt ?? 0;
      if (!prev || curLoaded > prevLoaded) byYear.set(y.year, y);
    }
    return [...byYear.values()].sort((a, b) => a.year - b.year);
  }, [feedOrder, feeds]);

  if (mode !== 'diff') return null;
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
  const firstYear = feedYears[0].year;
  const lastYear = feedYears[feedYears.length - 1].year;

  return (
    <div
      className="diff-timeline-strip"
      role="region"
      aria-label="Basemap year selector"
    >
      <span className="muted" aria-hidden><i className="fa-solid fa-satellite" /></span>
      <span className="muted" aria-hidden>{firstYear}</span>
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
      <span className="muted" aria-hidden>{lastYear}</span>
      <span className="timeline-current-year">{feedYears[clampedIndex].year}</span>
    </div>
  );
}
