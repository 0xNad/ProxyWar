import { describe, expect, test } from "vitest";
import {
  parseCoworldScoreEvaluatorOptions,
  parseSavedCoworldScoreEpisodes,
} from "../../src/scripts/coworld-score-evaluate";
import { evaluateSavedCoworldEpisodes } from "../../src/server/agents/CoworldScoreSemantics";

describe("Coworld saved-score evaluator CLI", () => {
  test("preserves repeated-policy seat scores when evaluating a rotating candidate", () => {
    const options = parseCoworldScoreEvaluatorOptions([
      "episodes.json",
      "--policy-version-id",
      "candidate",
    ]);
    const episodes = parseSavedCoworldScoreEpisodes(
      [
        {
          seat: 3,
          game_config: { map: "Europe" },
          policy_version_ids: ["opponent", "candidate", "opponent", "opponent"],
          scores: [
            { policy_version_id: "opponent", score: 0.6 },
            { policy_version_id: "candidate", score: 0.5 },
            { policy_version_id: "opponent", score: 0.1 },
            { policy_version_id: "opponent", score: 0.1 },
          ],
        },
      ],
      options,
    );
    const evaluation = evaluateSavedCoworldEpisodes(episodes);

    expect(episodes[0].seat).toBe(1);
    expect(episodes[0].scores).toEqual([0.6, 0.5, 0.1, 0.1]);
    expect(evaluation.episodes[0]).toMatchObject({
      seat: 1,
      score: 0.5,
      topScoreWin: false,
    });
  });

  test("evaluates every seat occupied by the selected repeated policy", () => {
    const options = parseCoworldScoreEvaluatorOptions([
      "episodes.json",
      "--policy-version-id",
      "candidate",
    ]);
    const episodes = parseSavedCoworldScoreEpisodes(
      [
        {
          game_config: { map: "Pangaea" },
          policy_version_ids: ["candidate", "opponent", "candidate"],
          scores: [
            { policy_version_id: "candidate", score: 0.45 },
            { policy_version_id: "opponent", score: 0.1 },
            { policy_version_id: "candidate", score: 0.45 },
          ],
        },
      ],
      options,
    );

    expect(episodes.map((episode) => episode.seat)).toEqual([0, 2]);
    expect(evaluateSavedCoworldEpisodes(episodes).summary).toMatchObject({
      episodes: 2,
      topScoreWins: 2,
      rawScoreSum: 0.9,
    });
  });

  test("explicit CLI seat overrides embedded episode metadata", () => {
    const options = parseCoworldScoreEvaluatorOptions([
      "episodes.json",
      "--seat",
      "1",
    ]);
    const episodes = parseSavedCoworldScoreEpisodes(
      [
        {
          seat: 3,
          map: "Asia",
          scores: [0.1, 0.6, 0.2, 0.1],
          winner_slot: null,
        },
      ],
      options,
    );

    expect(episodes[0].seat).toBe(1);
    expect(evaluateSavedCoworldEpisodes(episodes).episodes[0].topScoreWin).toBe(
      true,
    );
  });

  test("rejects simultaneous policy and seat selectors", () => {
    expect(() =>
      parseCoworldScoreEvaluatorOptions([
        "episodes.json",
        "--policy-version-id",
        "candidate",
        "--seat",
        "1",
      ]),
    ).toThrow("--seat and --policy-version-id are mutually exclusive");
  });
});
