import { parsePolicyLabel } from "../identity/IdentityMatching";
import type { StandingsHistorySnapshot } from "./CoworldLeagueStandingsHistory";

/**
 * Time-series stats computation (product overhaul: stats graphs). Pure,
 * shared by `ProxyWarPublicReadModel.ts` (`/agent/:slug`'s read-model
 * projection) and `LeaguePlayerProfile.ts` (`/api/players/:name`) — "one
 * computation source, two views, never divergent numbers" (the same
 * invariant `AgentStatsSchema.ts`'s own doc states for the fingerprint/
 * social stats) extends to these series: both consumers call the exact same
 * functions here against the exact same two on-disk inputs (the mirror's
 * retained `episodes` and the standings-history store), neither recomputes
 * with different logic.
 *
 * Winrate is computable from data this repo already retains honestly:
 * completed episodes carry a real timestamp and a real per-agent outcome.
 * Score/rank is NOT retroactively computable — see
 * `CoworldLeagueStandingsHistory.ts`'s own doc for why — so that series can
 * only ever grow forward from whenever the history store first started
 * recording, never backfilled.
 */

/** Minimum completed episodes (with a real outcome) before a winrate trend line means anything more than noise. Below this, the whole series is hidden — never a fabricated 1- or 2-point "trend". */
const WINRATE_SERIES_MIN_EPISODES = 5;
/** A "series" of one point isn't a series. Two real per-sync snapshots is the minimum something can be called a trend at all. */
const SCORE_SERIES_MIN_SNAPSHOTS = 2;
/**
 * The retained store predates Coworld's current rating regime and does not
 * carry an explicit regime id. A >=10x adjacent scale change is therefore a
 * conservative fail-closed boundary: points before the LAST such boundary
 * are not comparable to the current score and must not be connected into one
 * public trajectory. Ordinary rating movement is nowhere near an order of
 * magnitude; the live migration crossed this boundary by thousands-fold.
 */
const SCORE_REGIME_SCALE_RATIO = 10;

export interface WinLossEpisode {
  readonly completedAt: string | null;
  readonly isWinner: boolean;
}

export interface WinrateSeriesPoint {
  readonly completedAt: string;
  /** Cumulative wins / cumulative completed episodes, through and including this point, in chronological order. */
  readonly winRate: number;
  readonly episodesSoFar: number;
}

export interface WinrateSeries {
  readonly points: readonly WinrateSeriesPoint[];
  readonly threshold: number;
  readonly methodology: string;
}

export interface ScoreSeriesPoint {
  readonly recordedAt: string;
  readonly score: number;
  readonly rank: number;
  readonly activeVersionLabel: string | null;
  /**
   * True exactly when this is the first recorded snapshot carrying this
   * `activeVersionLabel` for this agent — a version-boundary marker,
   * "first observed" being the same term the identity registry's own
   * `firstObservedAt` provenance field uses (see
   * `IdentitySchemas.ts`/`sync-version-registry.ts`), applied here to what
   * THIS series has actually recorded rather than a registry join.
   */
  readonly versionFirstObserved: boolean;
}

export interface ScoreSeries {
  readonly points: readonly ScoreSeriesPoint[];
  readonly recordedSince: string;
  readonly methodology: string;
}

export interface AgentTimeSeries {
  readonly winrate: WinrateSeries | null;
  readonly score: ScoreSeries | null;
}

function isScoreRegimeBoundary(previous: number, current: number): boolean {
  const low = Math.min(Math.abs(previous), Math.abs(current));
  const high = Math.max(Math.abs(previous), Math.abs(current));
  if (high === 0) return false;
  if (low === 0) return high >= SCORE_REGIME_SCALE_RATIO;
  return high / low >= SCORE_REGIME_SCALE_RATIO;
}

const INTERNAL_POLICY_FAMILY_TOKEN =
  /(^|[-_\s])(e2e|smoke|test|tester|probe|audit|canary|candidate|baseline|control|experiment|debug|tmp|cert)([-_\s]|$)/i;

/**
 * Charts need a human version marker, not the raw Softmax policy label. Raw
 * labels remain available in the dedicated provenance/integrity surfaces;
 * reducing an ordinary `family:version` label to its bounded suffix here and
 * omitting explicit test/canary family names prevents internal experiment
 * labels from leaking into prominent chart annotations. Malformed labels fail
 * closed to no marker.
 */
function publicVersionMarker(policyLabel: string | null): string | null {
  if (policyLabel === null) return null;
  const parsed = parsePolicyLabel(policyLabel);
  if (parsed === null) {
    return /^v[a-z0-9._-]{0,18}$/i.test(policyLabel) ? policyLabel : null;
  }
  if (
    parsed.version.length > 20 ||
    INTERNAL_POLICY_FAMILY_TOKEN.test(parsed.family)
  ) {
    return null;
  }
  return parsed.version;
}

/**
 * Cumulative career winrate across every completed episode currently
 * retained for this agent, oldest first. `null` (the whole series hidden)
 * below `WINRATE_SERIES_MIN_EPISODES` dated episodes — the product spec's
 * "no ratios without real denominators" discipline applied to a series: a
 * 1- or 2-point line is not a trend worth showing.
 */
export function computeWinrateSeries(
  episodes: readonly WinLossEpisode[],
): WinrateSeries | null {
  const dated = episodes
    .filter(
      (episode): episode is { completedAt: string; isWinner: boolean } =>
        episode.completedAt !== null,
    )
    .slice()
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  if (dated.length < WINRATE_SERIES_MIN_EPISODES) return null;
  let wins = 0;
  const points = dated.map((episode, index) => {
    if (episode.isWinner) wins += 1;
    return {
      completedAt: episode.completedAt,
      winRate: wins / (index + 1),
      episodesSoFar: index + 1,
    };
  });
  return {
    points,
    threshold: WINRATE_SERIES_MIN_EPISODES,
    methodology: `cumulative wins / cumulative completed episodes, in chronological order, across every episode currently retained in the league mirror's rolling window (minimum ${WINRATE_SERIES_MIN_EPISODES} dated episodes to show a trend)`,
  };
}

/**
 * Per-agent score/rank/version series from the standings-history store.
 * `snapshots` MUST already be in chronological (append) order — the store
 * only ever appends, so every reader of it already satisfies this. `null`
 * (hidden) below `SCORE_SERIES_MIN_SNAPSHOTS` points carrying a real score
 * for this agent — a snapshot where this agent had no rated score yet
 * (`score: null`) is skipped rather than plotted as a fabricated zero.
 */
export function computeScoreSeries(
  snapshots: readonly StandingsHistorySnapshot[],
  playerName: string,
): ScoreSeries | null {
  const candidatePoints: Array<
    ScoreSeriesPoint & { readonly sourcePolicyLabel: string | null }
  > = [];
  let latestRegimeStart = 0;
  for (const snapshot of snapshots) {
    const entry = snapshot.agents.find((a) => a.playerName === playerName);
    if (entry === undefined || entry.score === null) continue;
    const previousPoint = candidatePoints[candidatePoints.length - 1];
    if (
      previousPoint !== undefined &&
      isScoreRegimeBoundary(previousPoint.score, entry.score)
    ) {
      latestRegimeStart = candidatePoints.length;
    }
    const previousSourceLabel = previousPoint?.sourcePolicyLabel ?? null;
    candidatePoints.push({
      recordedAt: snapshot.recordedAt,
      score: entry.score,
      rank: entry.rank,
      activeVersionLabel: publicVersionMarker(entry.activeVersionLabel),
      versionFirstObserved:
        entry.activeVersionLabel !== null &&
        entry.activeVersionLabel !== previousSourceLabel,
      sourcePolicyLabel: entry.activeVersionLabel,
    });
  }
  let previousPublishedSourceLabel: string | null = null;
  const points: ScoreSeriesPoint[] = candidatePoints
    .slice(latestRegimeStart)
    .map(({ sourcePolicyLabel, ...point }) => {
      const versionFirstObserved =
        point.activeVersionLabel !== null &&
        sourcePolicyLabel !== null &&
        sourcePolicyLabel !== previousPublishedSourceLabel;
      previousPublishedSourceLabel = sourcePolicyLabel;
      return { ...point, versionFirstObserved };
    });
  if (points.length < SCORE_SERIES_MIN_SNAPSHOTS) return null;
  return {
    points,
    recordedSince: points[0].recordedAt,
    methodology:
      latestRegimeStart > 0
        ? "one point per league-mirror sync where this agent's score, rank, or active version actually changed, within the most recent comparable score regime — earlier points are omitted after an order-of-magnitude scale discontinuity; never backfilled or interpolated across a gap"
        : "one point per league-mirror sync where this agent's score, rank, or active version actually changed, recorded since deployment of the standings-history store — never backfilled or interpolated across a gap",
  };
}

export function computeAgentTimeSeries(
  episodes: readonly WinLossEpisode[],
  snapshots: readonly StandingsHistorySnapshot[],
  playerName: string,
): AgentTimeSeries {
  return {
    winrate: computeWinrateSeries(episodes),
    score: computeScoreSeries(snapshots, playerName),
  };
}
