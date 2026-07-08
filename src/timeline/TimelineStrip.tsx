import { useEffect, useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { feedYearsOf, feedYearLabels, type FeedYear } from './math';

/**
 * Minimal year slider.
 *
 * Lists every loaded feed, sorted chronologically, and lets the user pick
 * one with a standard range input. Selecting an entry sets that feed as
 * active on the map. Two feeds can share a representative year (e.g. both
 * fall back to load time when GTFS dates are missing) — the slider still
 * shows both, keyed by feed id rather than year.
 */
export default function TimelineStrip() {
  const mode = useAppStore((s) => s.mode);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const timelineFeedId = useAppStore((s) => s.timelineFeedId);
  const setTimelineFeedId = useAppStore((s) => s.setTimelineFeedId);

  // Every loaded feed, sorted chronologically. Feeds that compute to the
  // same representative year both stay in the list (see feedYearsOf).
  const feedYears: FeedYear[] = useMemo(
    () => feedYearsOf(feedOrder, feeds),
    [feedOrder, feeds],
  );

  // Initialise / clamp the selection whenever the feed set changes.
  useEffect(() => {
    if (feedYears.length === 0) return;
    const stillPresent = feedYears.some((y) => y.feedId === timelineFeedId);
    if (timelineFeedId == null || !stillPresent) {
      setTimelineFeedId(feedYears[feedYears.length - 1].feedId);
    }
  }, [feedYears, timelineFeedId, setTimelineFeedId]);

  // Selected feed drives the active feed while in timeline mode.
  useEffect(() => {
    if (mode !== 'timeline') return;
    if (timelineFeedId == null) return;
    if (timelineFeedId !== activeFeedId && feeds[timelineFeedId]) {
      useAppStore.setState({ activeFeedId: timelineFeedId });
    }
  }, [mode, timelineFeedId, feeds, activeFeedId]);

  if (mode !== 'timeline') return null;
  if (feedYears.length < 2) return null;

  const labels = feedYearLabels(feedYears);
  const index = Math.max(0, feedYears.findIndex((y) => y.feedId === timelineFeedId));
  const current = feedYears[index] ?? feedYears[feedYears.length - 1];
  const currentFeedLabel = feeds[current.feedId]?.label ?? '';
  const tooltip = `${labels[index]} · ${currentFeedLabel}${current.synthetic ? ' (inferred)' : ''}`;

  return (
    <div className="timeline-strip" role="region" aria-label="Year selector" title={tooltip}>
      <span className="muted" aria-hidden>{labels[0]}</span>
      <input
        type="range"
        className="timeline-slider"
        min={0}
        max={feedYears.length - 1}
        step={1}
        value={index}
        onChange={(e) => {
          const i = Number(e.target.value);
          setTimelineFeedId(feedYears[i].feedId);
        }}
        aria-label="Select year"
      />
      <span className="muted" aria-hidden>{labels[labels.length - 1]}</span>
      <span className="timeline-current-year">{labels[index]}</span>
    </div>
  );
}
