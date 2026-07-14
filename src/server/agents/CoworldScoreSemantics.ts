/**
 * Score transforms shared by the Coworld mirror and offline evaluation tools.
 *
 * The league commissioner awards an episode win to every seat whose raw score
 * equals the episode maximum. This deliberately treats a fractional timeout
 * leader as a winner and gives every tied maximum a win, including all seats
 * when every score is zero.
 */

export function commissionerEpisodeWinPoints(
  scores: readonly number[],
): number[] {
  if (scores.length === 0) {
    return [];
  }
  const topScore = Math.max(...scores);
  return scores.map((score) => (score === topScore ? 1 : 0));
}

export function commissionerTopScoreSlots(scores: readonly number[]): number[] {
  const points = commissionerEpisodeWinPoints(scores);
  const slots: number[] = [];
  for (let slot = 0; slot < points.length; slot += 1) {
    if (points[slot] === 1) {
      slots.push(slot);
    }
  }
  return slots;
}

export interface SavedCoworldEpisodeScore {
  map: string;
  seat: number;
  scores: readonly number[];
  outrightWinnerSlot: number | null;
}

export interface CoworldEpisodeScoreEvaluation {
  map: string;
  seat: number;
  score: number;
  topScoreWin: boolean;
  outrightWin: boolean;
}

export interface CoworldScoreAggregate {
  episodes: number;
  topScoreWins: number;
  outrightWins: number;
  rawScoreSum: number;
  rawScoreMean: number | null;
}

export interface CoworldSavedEpisodeEvaluation {
  episodes: CoworldEpisodeScoreEvaluation[];
  summary: CoworldScoreAggregate;
  byMap: Record<string, CoworldScoreAggregate>;
  bySeat: Record<string, CoworldScoreAggregate>;
}

function aggregate(
  episodes: readonly CoworldEpisodeScoreEvaluation[],
): CoworldScoreAggregate {
  const rawScoreSum = episodes.reduce((sum, episode) => sum + episode.score, 0);
  return {
    episodes: episodes.length,
    topScoreWins: episodes.filter((episode) => episode.topScoreWin).length,
    outrightWins: episodes.filter((episode) => episode.outrightWin).length,
    rawScoreSum,
    rawScoreMean: episodes.length === 0 ? null : rawScoreSum / episodes.length,
  };
}

function aggregateBy(
  episodes: readonly CoworldEpisodeScoreEvaluation[],
  key: (episode: CoworldEpisodeScoreEvaluation) => string,
): Record<string, CoworldScoreAggregate> {
  const grouped = new Map<string, CoworldEpisodeScoreEvaluation[]>();
  for (const episode of episodes) {
    const groupKey = key(episode);
    const group = grouped.get(groupKey) ?? [];
    group.push(episode);
    grouped.set(groupKey, group);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([groupKey, group]) => [groupKey, aggregate(group)]),
  );
}

export function evaluateSavedCoworldEpisodes(
  episodes: readonly SavedCoworldEpisodeScore[],
): CoworldSavedEpisodeEvaluation {
  const evaluated = episodes.map((episode) => {
    if (!Number.isInteger(episode.seat) || episode.seat < 0) {
      throw new Error(`Invalid Coworld seat: ${episode.seat}`);
    }
    const score = episode.scores[episode.seat];
    if (score === undefined || !Number.isFinite(score)) {
      throw new Error(
        `Coworld seat ${episode.seat} has no finite score on ${episode.map}`,
      );
    }
    return {
      map: episode.map,
      seat: episode.seat,
      score,
      topScoreWin: commissionerTopScoreSlots(episode.scores).includes(
        episode.seat,
      ),
      outrightWin: episode.outrightWinnerSlot === episode.seat,
    };
  });

  return {
    episodes: evaluated,
    summary: aggregate(evaluated),
    byMap: aggregateBy(evaluated, (episode) => episode.map),
    bySeat: aggregateBy(evaluated, (episode) => String(episode.seat)),
  };
}
