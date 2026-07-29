import { useEffect, useMemo } from 'react';
import { useAppStore } from '../state/app-store';
import { feedYearsOf, feedYearLabels, type FeedYear } from './math';

const PLAYBACK_SPEEDS = [
  { ms: 2400, label: 'Slow' },
  { ms: 1200, label: 'Normal' },
  { ms: 600, label: 'Fast' },
];

/**
 * Year slider for the Timeline layout.
 *
 * Lists every loaded feed, sorted chronologically, and lets the user pick
 * one with a standard range input (or play through them automatically).
 * Selecting an entry sets that feed as active on the map. Two feeds can
 * share a representative year (e.g. both fall back to load time when GTFS
 * dates are missing) — the slider still shows both, keyed by feed id rather
 * than year.
 *
 * Also hosts the baseline picker (the resulting diff narrative/metrics live
 * in `TimelineChangePanel`, in the right panel).
 */
export default function TimelineStrip() {
  const diffOverviewLayout = useAppStore((s) => s.diffOverviewLayout);
  const feedOrder = useAppStore((s) => s.feedOrder);
  const feeds = useAppStore((s) => s.feeds);
  const activeFeedId = useAppStore((s) => s.activeFeedId);
  const compareFeedId = useAppStore((s) => s.compareFeedId);
  const timelineFeedId = useAppStore((s) => s.timelineFeedId);
  const setTimelineFeedId = useAppStore((s) => s.setTimelineFeedId);
  const timelinePlaying = useAppStore((s) => s.timelinePlaying);
  const setTimelinePlaying = useAppStore((s) => s.setTimelinePlaying);
  const timelinePlaybackSpeedMs = useAppStore((s) => s.timelinePlaybackSpeedMs);
  const setTimelinePlaybackSpeedMs = useAppStore((s) => s.setTimelinePlaybackSpeedMs);
  const feedASelection = useAppStore((s) => s.feedASelection);
  const setFeedASelection = useAppStore((s) => s.setFeedASelection);
  const timelineCumulativeMode = useAppStore((s) => s.timelineCumulativeMode);
  const setTimelineCumulativeMode = useAppStore((s) => s.setTimelineCumulativeMode);
  const timelineHighlightGrowth = useAppStore((s) => s.timelineHighlightGrowth);
  const setTimelineHighlightGrowth = useAppStore((s) => s.setTimelineHighlightGrowth);
  const timelineHighlightLoss = useAppStore((s) => s.timelineHighlightLoss);
  const setTimelineHighlightLoss = useAppStore((s) => s.setTimelineHighlightLoss);
  const timelineHighlightReroutes = useAppStore((s) => s.timelineHighlightReroutes);
  const setTimelineHighlightReroutes = useAppStore((s) => s.setTimelineHighlightReroutes);
  const timelineNetChangesMode = useAppStore((s) => s.timelineNetChangesMode);
  const setTimelineNetChangesMode = useAppStore((s) => s.setTimelineNetChangesMode);

  // Every loaded feed, sorted chronologically. Feeds that compute to the
  // same representative year both stay in the list (see feedYearsOf).
  const allFeedYears: FeedYear[] = useMemo(
    () => feedYearsOf(feedOrder, feeds),
    [feedOrder, feeds],
  );

  // The strip is bounded to the range set by the topbar's A/B feed slots:
  // baseline (A) is the start of the line, the compare feed (B) is the end.
  // Falls back to the full loaded range until both slots are set.
  const feedYears: FeedYear[] = useMemo(() => {
    if (!feedASelection || !compareFeedId) return allFeedYears;
    const baseIdx = allFeedYears.findIndex((y) => y.feedId === feedASelection);
    const endIdx = allFeedYears.findIndex((y) => y.feedId === compareFeedId);
    if (baseIdx < 0 || endIdx < 0) return allFeedYears;
    const [lo, hi] = baseIdx <= endIdx ? [baseIdx, endIdx] : [endIdx, baseIdx];
    return allFeedYears.slice(lo, hi + 1);
  }, [allFeedYears, feedASelection, compareFeedId]);

  // Initialise / clamp the selection whenever the bounded range changes.
  useEffect(() => {
    if (feedYears.length === 0) return;
    const stillPresent = feedYears.some((y) => y.feedId === timelineFeedId);
    if (timelineFeedId == null || !stillPresent) {
      setTimelineFeedId(feedYears[feedYears.length - 1].feedId);
    }
  }, [feedYears, timelineFeedId, setTimelineFeedId]);

  // Initialise Feed A to the earliest loaded feed the first time feeds appear.
  useEffect(() => {
    if (allFeedYears.length === 0) return;
    const stillPresent = allFeedYears.some((y) => y.feedId === feedASelection);
    if (feedASelection == null || !stillPresent) {
      setFeedASelection(allFeedYears[0].feedId);
    }
  }, [allFeedYears, feedASelection, setFeedASelection]);

  // Selected feed drives the active feed while the timeline layout is shown.
  useEffect(() => {
    if (diffOverviewLayout !== 'timeline') return;
    if (timelineFeedId == null) return;
    if (timelineFeedId !== activeFeedId && feeds[timelineFeedId]) {
      useAppStore.setState({ activeFeedId: timelineFeedId });
    }
  }, [diffOverviewLayout, timelineFeedId, feeds, activeFeedId]);

  // Outside timeline layout there's no scrub cursor — the map should simply
  // mirror the persistent Feed A selection, so switching away from timeline
  // (where activeFeedId was tracking the scrub position) can't leave A/B
  // looking like they changed.
  useEffect(() => {
    if (diffOverviewLayout === 'timeline') return;
    if (feedASelection == null) return;
    if (feedASelection !== activeFeedId && feeds[feedASelection]) {
      useAppStore.setState({ activeFeedId: feedASelection });
    }
  }, [diffOverviewLayout, feedASelection, feeds, activeFeedId]);

  // Auto-advance through the feed-years while playing, looping at the end.
  useEffect(() => {
    if (!timelinePlaying) return;
    if (diffOverviewLayout !== 'timeline') return;
    if (feedYears.length < 2) return;
    const id = window.setInterval(() => {
      const { timelineFeedId: current } = useAppStore.getState();
      const idx = feedYears.findIndex((y) => y.feedId === current);
      const nextIdx = idx < 0 ? 0 : (idx + 1) % feedYears.length;
      setTimelineFeedId(feedYears[nextIdx].feedId);
    }, timelinePlaybackSpeedMs);
    return () => window.clearInterval(id);
  }, [timelinePlaying, diffOverviewLayout, feedYears, timelinePlaybackSpeedMs, setTimelineFeedId]);

  // Stop playback if the timeline layout is left or there's nothing to animate.
  useEffect(() => {
    if (diffOverviewLayout !== 'timeline' || feedYears.length < 2) {
      if (timelinePlaying) setTimelinePlaying(false);
    }
  }, [diffOverviewLayout, feedYears.length, timelinePlaying, setTimelinePlaying]);

  if (diffOverviewLayout !== 'timeline') return null;
  if (feedYears.length < 2) return null;

  const labels = feedYearLabels(feedYears);
  const index = Math.max(0, feedYears.findIndex((y) => y.feedId === timelineFeedId));
  const current = feedYears[index] ?? feedYears[feedYears.length - 1];
  const currentFeedLabel = feeds[current.feedId]?.label ?? '';
  const tooltip = `${labels[index]} · ${currentFeedLabel}${current.synthetic ? ' (inferred)' : ''}`;

  const stepBy = (delta: number) => {
    const next = Math.min(feedYears.length - 1, Math.max(0, index + delta));
    setTimelineFeedId(feedYears[next].feedId);
  };

  return (
    <div className="timeline-strip" role="region" aria-label="Timeline controls">
      <div className="timeline-playback-controls">
        <button
          type="button"
          onClick={() => stepBy(-1)}
          disabled={index <= 0}
          title="Previous year"
          aria-label="Previous year"
        >
          ⏮
        </button>
        <button
          type="button"
          onClick={() => setTimelinePlaying(!timelinePlaying)}
          title={timelinePlaying ? 'Pause' : 'Play'}
          aria-label={timelinePlaying ? 'Pause' : 'Play'}
        >
          {timelinePlaying ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => stepBy(1)}
          disabled={index >= feedYears.length - 1}
          title="Next year"
          aria-label="Next year"
        >
          ⏭
        </button>
        <select
          value={timelinePlaybackSpeedMs}
          onChange={(e) => setTimelinePlaybackSpeedMs(Number(e.target.value))}
          aria-label="Playback speed"
          title="Playback speed"
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s.ms} value={s.ms}>{s.label}</option>
          ))}
        </select>
      </div>

      <div className="timeline-slider-row" title={tooltip}>
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

      <div className="timeline-baseline-controls">
        <label className="timeline-baseline-label" style={{ fontSize: 12 }} title="Compare against the baseline year (cumulative) instead of the previous loaded year (this step)">
          <input
            type="checkbox"
            checked={timelineCumulativeMode}
            onChange={(e) => setTimelineCumulativeMode(e.target.checked)}
          />
          {' '}Cumulative since baseline
        </label>
        {timelineCumulativeMode && (
          <label
            className="timeline-baseline-label"
            style={{ fontSize: 12 }}
            title="Net (default): a stop added then later removed nets out — shows what's really changed. All data changes: every add/remove event since baseline, including reversals."
          >
            <input
              type="checkbox"
              checked={!timelineNetChangesMode}
              onChange={(e) => setTimelineNetChangesMode(!e.target.checked)}
            />
            {' '}Show all data changes
          </label>
        )}
        <label className="timeline-baseline-label" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={timelineHighlightGrowth}
            onChange={(e) => setTimelineHighlightGrowth(e.target.checked)}
          />
          {' '}Highlight growth
        </label>
        <label className="timeline-baseline-label" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={timelineHighlightLoss}
            onChange={(e) => setTimelineHighlightLoss(e.target.checked)}
          />
          {' '}Highlight loss
        </label>
        <label className="timeline-baseline-label" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={timelineHighlightReroutes}
            onChange={(e) => setTimelineHighlightReroutes(e.target.checked)}
          />
          {' '}Highlight reroutes
        </label>
      </div>
    </div>
  );
}
