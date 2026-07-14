import { describe, expect, test } from "vitest";
import {
  commissionerEpisodeWinPoints,
  commissionerTopScoreSlots,
  evaluateSavedCoworldEpisodes,
} from "../../src/server/agents/CoworldScoreSemantics";

describe("Coworld commissioner score semantics", () => {
  test("credits a fractional maximum", () => {
    const scores = [0.12, 0.53232, 0.24768, 0.1];
    expect(commissionerEpisodeWinPoints(scores)).toEqual([0, 1, 0, 0]);
    expect(commissionerTopScoreSlots(scores)).toEqual([1]);
  });

  test("credits every seat tied at the maximum", () => {
    expect(commissionerEpisodeWinPoints([0.4, 0.1, 0.4, 0.1])).toEqual([
      1, 0, 1, 0,
    ]);
    expect(commissionerTopScoreSlots([0.4, 0.1, 0.4, 0.1])).toEqual([0, 2]);
  });

  test("returns no points for an empty episode", () => {
    expect(commissionerEpisodeWinPoints([])).toEqual([]);
    expect(commissionerTopScoreSlots([])).toEqual([]);
  });

  test("credits every seat when all scores are zero", () => {
    expect(commissionerEpisodeWinPoints([0, 0, 0, 0])).toEqual([1, 1, 1, 1]);
    expect(commissionerTopScoreSlots([0, 0, 0, 0])).toEqual([0, 1, 2, 3]);
  });

  test("reports top-score wins separately from outright wins by map and seat", () => {
    const evaluation = evaluateSavedCoworldEpisodes([
      {
        map: "Europe",
        seat: 0,
        scores: [0.6, 0.2, 0.1, 0.1],
        outrightWinnerSlot: null,
      },
      {
        map: "Europe",
        seat: 1,
        scores: [0, 1, 0, 0],
        outrightWinnerSlot: 1,
      },
      {
        map: "Asia",
        seat: 0,
        scores: [0.25, 0.5, 0.15, 0.1],
        outrightWinnerSlot: null,
      },
    ]);

    expect(evaluation.summary).toEqual({
      episodes: 3,
      topScoreWins: 2,
      outrightWins: 1,
      rawScoreSum: 1.85,
      rawScoreMean: 1.85 / 3,
    });
    expect(evaluation.byMap.Europe).toEqual({
      episodes: 2,
      topScoreWins: 2,
      outrightWins: 1,
      rawScoreSum: 1.6,
      rawScoreMean: 0.8,
    });
    expect(evaluation.bySeat["0"]).toEqual({
      episodes: 2,
      topScoreWins: 1,
      outrightWins: 0,
      rawScoreSum: 0.85,
      rawScoreMean: 0.425,
    });
    expect(evaluation.episodes[0]).toEqual({
      map: "Europe",
      seat: 0,
      score: 0.6,
      topScoreWin: true,
      outrightWin: false,
    });
  });
});
