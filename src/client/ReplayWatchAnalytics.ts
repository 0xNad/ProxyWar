import { analytics } from "./analytics/AnalyticsClient";

/**
 * Watch-progress milestones for replay surfaces. Extracted from the retired
 * league replay overlay so the retention funnel keeps measuring after the
 * custom skin's removal.
 *
 * `activePlaybackMs` — NOT wall-clock since first frame — drives the 30s/2m
 * milestones: a paused, backgrounded, or buffering viewer must never inflate
 * the retention funnel. Each consecutive frame pair's real delta is added,
 * capped at `MAX_FRAME_DELTA_MS` so a stall (or the gap before the very first
 * frame) can never masquerade as watched time, and accumulation halts while
 * `document.hidden`. Turn progress against the match's total turn count
 * drives 50%; the frame's own `terminal` flag drives completion. Each
 * milestone fires exactly one `analytics.track` call per view.
 */
export function mountReplayWatchAnalytics(options: {
  matchId: string;
  totalTurns: number;
}): () => void {
  const MAX_FRAME_DELTA_MS = 2_000;
  const watchMilestonesSent = new Set<string>();
  let lastFrameAt: number | null = null;
  let activePlaybackMs = 0;
  const trackWatchMilestoneOnce = (
    name: "watched_30s" | "watched_2m" | "watched_50pct" | "completed",
  ): void => {
    if (watchMilestonesSent.has(name)) return;
    watchMilestonesSent.add(name);
    analytics.track(name, {
      matchId: options.matchId,
    });
  };
  const onWatchProgressFrame = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ turnNumber?: unknown; terminal?: unknown }>
    ).detail;
    if (
      typeof detail?.turnNumber !== "number" ||
      !Number.isFinite(detail.turnNumber)
    ) {
      return;
    }
    const now = Date.now();
    if (lastFrameAt !== null && !document.hidden) {
      const deltaMs = now - lastFrameAt;
      if (deltaMs > 0) {
        activePlaybackMs += Math.min(deltaMs, MAX_FRAME_DELTA_MS);
      }
    }
    lastFrameAt = now;
    if (activePlaybackMs >= 30_000) trackWatchMilestoneOnce("watched_30s");
    if (activePlaybackMs >= 120_000) trackWatchMilestoneOnce("watched_2m");
    if (
      options.totalTurns > 0 &&
      detail.turnNumber / options.totalTurns >= 0.5
    ) {
      trackWatchMilestoneOnce("watched_50pct");
    }
    if (detail.terminal === true) trackWatchMilestoneOnce("completed");
  };
  document.addEventListener("ai-league-replay-frame", onWatchProgressFrame);
  return () =>
    document.removeEventListener("ai-league-replay-frame", onWatchProgressFrame);
}
