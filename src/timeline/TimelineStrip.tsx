import { useEffect, useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { yearOfFeed, type FeedYear } from './math';

/**
 * Minimal year slider.
 *
 * Collapses the loaded feeds to one entry per representative year and lets the
 * user pick one with a standard range input. Selecting a year sets that feed
 * as active on the map. When a year has multiple feeds (rare), the one loaded
 * most recently wins.
 */
export default function TimelineStrip() {
  const mode = useAppStore((s) => s.mode);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const timelineYear = useAppStore((s) => s.timelineYear);
  const setTimelineYear = useAppStore((s) => s.setTimelineYear);

  // Unique, sorted feed-years. Ties broken by most-recently-loaded feed.
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

  // Initialise / clamp the timeline year whenever the feed set changes.
  useEffect(() => {
    if (feedYears.length === 0) return;
    const available = feedYears.map((y) => y.year);
    if (timelineYear == null || !available.includes(timelineYear)) {
      setTimelineYear(available[available.length - 1]);
    }
  }, [feedYears, timelineYear, setTimelineYear]);

  // Selected year drives the active feed while in timeline mode.
  useEffect(() => {
    if (mode !== 'timeline') return;
    if (timelineYear == null) return;
    const match = feedYears.find((y) => y.year === timelineYear);
    if (match && match.feedId !== activeFeedId) {
      useAppStore.setState({ activeFeedId: match.feedId });
    }
  }, [mode, timelineYear, feedYears, activeFeedId]);

  if (mode !== 'timeline') return null;
  if (feedYears.length < 2) return null;

  const index = Math.max(0, feedYears.findIndex((y) => y.year === timelineYear));
  const current = feedYears[index] ?? feedYears[feedYears.length - 1];
  const currentLabel = feeds[current.feedId]?.label ?? '';
  const firstYear = feedYears[0].year;
  const lastYear = feedYears[feedYears.length - 1].year;
  const tooltip = `${current.year} · ${currentLabel}${current.synthetic ? ' (inferred)' : ''}`;

  return (
    <div className="timeline-strip" role="region" aria-label="Year selector" title={tooltip}>
      <span className="muted" aria-hidden>{firstYear}</span>
      <input
        type="range"
        className="timeline-slider"
        min={0}
        max={feedYears.length - 1}
        step={1}
        value={index}
        onChange={(e) => {
          const i = Number(e.target.value);
          setTimelineYear(feedYears[i].year);
        }}
        aria-label="Select year"
      />
      <span className="muted" aria-hidden>{lastYear}</span>
      <span className="timeline-current-year">{current.year}</span>
    </div>
  );
}
