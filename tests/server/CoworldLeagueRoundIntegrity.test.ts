import { describe, expect, test } from "vitest";
import {
  coworldRoundIntegrityCriticalSignal,
  evaluateCoworldRoundIntegrity,
  isCoworldPhantomCompletedEpisode,
  isCoworldScoreBearingEpisode,
  parseCoworldLadderIntegritySettings,
  reconcileCoworldRoundIntegrity,
  retainCoworldRoundIntegrityOnIncompleteProbe,
  type CoworldLadderIntegritySettings,
  type CoworldRoundIntegrityAssessment,
} from "../../src/server/agents/CoworldLeagueRoundIntegrity";

const settings: CoworldLadderIntegritySettings = {
  expectedEpisodesPerRound: 25,
  roundIntervalMinutes: 25,
  allowedFailureRate: 0.05,
  allowedFailureCount: 1,
};

const completedRound = {
  id: "round_test",
  round_number: 1897,
  status: "completed",
  completed_at: "2026-08-21T19:19:43.947983Z",
};

function scoreBearingEpisode(index: number): Record<string, unknown> {
  return {
    id: `ereq_${index}`,
    round_id: completedRound.id,
    status: "completed",
    episode_id: `episode_${index}`,
    running_at: "2026-08-21T19:15:31.000Z",
    completed_at: "2026-08-21T19:18:30.000Z",
    error: null,
    policy_version_ids: [`policy_${index}_a`, `policy_${index}_b`],
    scores: [
      { policy_version_id: `policy_${index}_a`, score: 1 },
      { policy_version_id: `policy_${index}_b`, score: 0 },
    ],
  };
}

function phantomEpisode(index: number): Record<string, unknown> {
  return {
    id: `ereq_${index}`,
    round_id: completedRound.id,
    status: "completed",
    episode_id: null,
    running_at: null,
    completed_at: "2026-08-21T19:14:00.000Z",
    error: null,
    policy_version_ids: [`policy_${index}_a`, `policy_${index}_b`],
    scores: [],
  };
}

function rows(valid: number, phantom: number): Record<string, unknown>[] {
  return [
    ...Array.from({ length: valid }, (_, index) => scoreBearingEpisode(index)),
    ...Array.from({ length: phantom }, (_, offset) =>
      phantomEpisode(valid + offset),
    ),
  ];
}

function assessmentFor(
  episodeRows: Record<string, unknown>[],
): CoworldRoundIntegrityAssessment {
  const result = evaluateCoworldRoundIntegrity({
    round: completedRound,
    episodeRows,
    settings,
  });
  expect(result.kind).toBe("assessed");
  if (result.kind !== "assessed") throw new Error("expected assessment");
  return result.assessment;
}

describe("Coworld ladder round integrity", () => {
  test("parses current settings.ladder episode, cadence, and tolerance truth", () => {
    expect(
      parseCoworldLadderIntegritySettings({
        id: "league_test",
        settings: {
          ladder: {
            scheduler: { num_episodes: 25 },
            fulfillment: { allowed_failures: 0.05 },
          },
          round_interval_minutes: 25,
        },
        commissioner_config: {
          schedule_interval_minutes: 30,
          stages: [{ num_episodes: 8 }],
        },
      }),
    ).toEqual(settings);
  });

  test("25/25 score-bearing episodes are healthy", () => {
    expect(assessmentFor(rows(25, 0))).toMatchObject({
      scoreBearingCount: 25,
      effectiveFailureCount: 0,
      phantomFailureCount: 0,
      verdict: "healthy",
    });
  });

  test("24/25 is inside the configured one-failure tolerance", () => {
    const assessment = assessmentFor(rows(24, 1));
    expect(assessment).toMatchObject({
      scoreBearingCount: 24,
      effectiveFailureCount: 1,
      phantomFailureCount: 1,
      allowedFailureCount: 1,
      verdict: "healthy",
    });
    expect(coworldRoundIntegrityCriticalSignal(assessment)).toBeNull();
  });

  test("23/25 breaches the configured tolerance", () => {
    expect(assessmentFor(rows(23, 2))).toMatchObject({
      scoreBearingCount: 23,
      effectiveFailureCount: 2,
      allowedFailureCount: 1,
      verdict: "breach",
    });
  });

  test("round 1897's 11 score-bearing plus 14 exact phantoms bites", () => {
    const assessment = assessmentFor(rows(11, 14));
    expect(assessment).toMatchObject({
      roundNumber: 1897,
      observedEpisodeCount: 25,
      scoreBearingCount: 11,
      effectiveFailureCount: 14,
      phantomFailureCount: 14,
      otherFailureCount: 0,
      verdict: "breach",
    });
    expect(coworldRoundIntegrityCriticalSignal(assessment)).toEqual({
      class: "round_incomplete_execution",
      key: "round_test",
      severity: "critical",
      detail:
        "round 1897 produced 11/25 score-bearing episodes; 14 effective failure(s) exceed the allowed 1; 14 match the completed-without-running phantom signature",
    });
  });

  test("round 1884-style 19 score-bearing plus 6 phantoms bites", () => {
    expect(assessmentFor(rows(19, 6))).toMatchObject({
      scoreBearingCount: 19,
      effectiveFailureCount: 6,
      phantomFailureCount: 6,
      verdict: "breach",
    });
  });

  test("the phantom classifier matches only the exact completed signature", () => {
    expect(isCoworldPhantomCompletedEpisode(phantomEpisode(1))).toBe(true);
    expect(
      isCoworldPhantomCompletedEpisode({
        ...phantomEpisode(1),
        error: "dispatch failed",
      }),
    ).toBe(false);
  });

  test("null scores are an effective failure, never score-bearing", () => {
    const episode = { ...scoreBearingEpisode(24), scores: null };
    expect(isCoworldScoreBearingEpisode(episode)).toBe(false);
    expect(assessmentFor([...rows(24, 0), episode])).toMatchObject({
      scoreBearingCount: 24,
      otherFailureCount: 1,
      verdict: "healthy",
    });
  });

  test("empty scores are an effective failure", () => {
    const episode = { ...scoreBearingEpisode(24), scores: [] };
    expect(isCoworldScoreBearingEpisode(episode)).toBe(false);
    expect(assessmentFor([...rows(24, 0), episode])).toMatchObject({
      otherFailureCount: 1,
    });
  });

  test("duplicate policy score rows are an effective failure", () => {
    const episode = {
      ...scoreBearingEpisode(24),
      scores: [
        { policy_version_id: "policy_24_a", score: 1 },
        { policy_version_id: "policy_24_a", score: 0 },
      ],
    };
    expect(isCoworldScoreBearingEpisode(episode)).toBe(false);
    expect(assessmentFor([...rows(24, 0), episode])).toMatchObject({
      otherFailureCount: 1,
    });
  });

  test("partial scores are an effective failure", () => {
    const episode = {
      ...scoreBearingEpisode(24),
      scores: [{ policy_version_id: "policy_24_a", score: 1 }],
    };
    expect(isCoworldScoreBearingEpisode(episode)).toBe(false);
    expect(assessmentFor([...rows(24, 0), episode])).toMatchObject({
      otherFailureCount: 1,
    });
  });

  test("an in-progress round is ignored even when its rows have no scores", () => {
    expect(
      evaluateCoworldRoundIntegrity({
        round: {
          ...completedRound,
          status: "running",
          completed_at: null,
        },
        episodeRows: rows(0, 25),
        settings,
      }),
    ).toEqual({
      kind: "ignored",
      reason: "round_not_terminal_completed",
    });
  });

  test("a terminal round with only 23/25 visible rows is incomplete evidence", () => {
    expect(
      evaluateCoworldRoundIntegrity({
        round: completedRound,
        episodeRows: rows(23, 0),
        settings,
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "episode_count_incomplete",
      observedEpisodeCount: 23,
    });
  });

  test("a terminal round with a still-running episode is incomplete evidence", () => {
    const episodeRows = rows(25, 0);
    episodeRows[24] = { ...episodeRows[24], status: "running" };
    expect(
      evaluateCoworldRoundIntegrity({
        round: completedRound,
        episodeRows,
        settings,
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "episode_still_in_progress",
    });
  });

  test.each([
    ["missing", undefined],
    ["mismatched", "round_other"],
  ])("a terminal round with a %s row round id is incomplete", (_, roundId) => {
    const episodeRows = rows(25, 0);
    episodeRows[24] = { ...episodeRows[24], round_id: roundId };
    expect(
      evaluateCoworldRoundIntegrity({
        round: completedRound,
        episodeRows,
        settings,
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "episode_round_mismatch",
    });
  });

  test("one terminal breach only becomes degraded after the same evidence persists 60s", () => {
    const breach = assessmentFor(rows(11, 14));
    const first = reconcileCoworldRoundIntegrity({
      previous: null,
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:00:00.000Z",
    });
    expect(first?.status).toBe("confirmation_pending");
    const early = reconcileCoworldRoundIntegrity({
      previous: first,
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:00:59.999Z",
    });
    expect(early?.status).toBe("confirmation_pending");
    const confirmed = reconcileCoworldRoundIntegrity({
      previous: early,
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:01:00.000Z",
    });
    expect(confirmed?.status).toBe("degraded");
    expect(confirmed?.lastConfirmedBreach).toEqual(breach);
  });

  test("changed breach evidence restarts confirmation", () => {
    const firstBreach = assessmentFor(rows(11, 14));
    const first = reconcileCoworldRoundIntegrity({
      previous: null,
      settings,
      assessments: [firstBreach],
      checkedAt: "2026-08-21T20:00:00.000Z",
    });
    const changedBreach = assessmentFor(rows(19, 6));
    const changed = reconcileCoworldRoundIntegrity({
      previous: first,
      settings,
      assessments: [changedBreach],
      checkedAt: "2026-08-21T20:02:00.000Z",
    });
    expect(changed?.status).toBe("confirmation_pending");
    expect(changed?.lastConfirmedBreach).toBeNull();
  });

  test("a later healthy terminal round clears current degradation but retains last breach", () => {
    const breach = assessmentFor(rows(11, 14));
    const pending = reconcileCoworldRoundIntegrity({
      previous: null,
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:00:00.000Z",
    });
    const degraded = reconcileCoworldRoundIntegrity({
      previous: pending,
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:01:00.000Z",
    });
    const healthy = {
      ...assessmentFor(rows(25, 0)),
      roundId: "round_1898",
      roundNumber: 1898,
      completedAt: "2026-08-21T20:20:00.000Z",
    };
    const cleared = reconcileCoworldRoundIntegrity({
      previous: degraded,
      settings,
      assessments: [healthy, breach],
      checkedAt: "2026-08-21T20:21:00.000Z",
    });
    expect(cleared?.status).toBe("healthy");
    expect(cleared?.latestCompletedRound).toEqual(healthy);
    expect(cleared?.lastConfirmedBreach).toEqual(breach);
  });

  test("an incomplete probe retains the last verified assessment unchanged", () => {
    const breach = assessmentFor(rows(11, 14));
    const previous = reconcileCoworldRoundIntegrity({
      previous: reconcileCoworldRoundIntegrity({
        previous: null,
        settings,
        assessments: [breach],
        checkedAt: "2026-08-21T20:00:00.000Z",
      }),
      settings,
      assessments: [breach],
      checkedAt: "2026-08-21T20:01:00.000Z",
    });
    expect(retainCoworldRoundIntegrityOnIncompleteProbe(previous)).toBe(
      previous,
    );
  });

  test("an incomplete cold-start probe fabricates no assessment", () => {
    expect(retainCoworldRoundIntegrityOnIncompleteProbe(null)).toBeUndefined();
  });
});
