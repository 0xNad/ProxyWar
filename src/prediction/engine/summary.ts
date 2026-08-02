/**
 * Season summaries — SPEC §6 leaderboard: final bankroll, ROI, accuracy.
 */
import { BP_ONE, type Season, type SeasonSummary } from "../types";

export function summarizeSeason(season: Season): SeasonSummary {
  const staked = season.stakes.reduce((a, s) => a + s.amount, 0);
  const returned = season.resolutions.reduce((a, r) => a + r.returned, 0);
  const roiBp =
    staked === 0 ? null : Math.round(((returned - staked) * BP_ONE) / staked);

  const decided = season.resolutions.filter((r) => r.state !== "void");
  const won = decided.filter((r) => r.state === "won").length;
  const accuracyBp =
    decided.length === 0 ? null : Math.round((won * BP_ONE) / decided.length);

  return {
    index: season.index,
    finalBankroll: season.bankroll,
    roiBp,
    accuracyBp,
    resolvedCount: season.resolutions.length,
    startedAtIso: season.startedAtIso,
  };
}
