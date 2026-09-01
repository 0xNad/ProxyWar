import { describe, expect, test } from "vitest";
import { evaluateCoworldLeagueSchedulerHealth } from "../../src/server/agents/CoworldLeagueSchedulerHealth";

const recoveredRounds = [
  {
    round_number: 2119,
    status: "completed",
    created_at: "2026-08-31T16:30:00.000Z",
    started_at: "2026-08-31T16:32:00.000Z",
    completed_at: "2026-08-31T17:04:23.000Z",
  },
  {
    round_number: 2120,
    status: "completed",
    created_at: "2026-09-01T07:00:06.000Z",
    started_at: "2026-09-01T07:02:00.000Z",
    completed_at: "2026-09-01T07:20:00.000Z",
  },
  {
    round_number: 2131,
    status: "pending",
    created_at: "2026-09-01T15:30:00.000Z",
    started_at: null,
    completed_at: null,
  },
];

describe("Coworld league scheduler health", () => {
  test("retains the observed 13h55m43s gap after current cadence recovers", () => {
    expect(
      evaluateCoworldLeagueSchedulerHealth({
        rounds: recoveredRounds,
        roundsPausedAt: null,
        roundIntervalMinutes: 25,
        checkedAt: "2026-09-01T15:41:00.000Z",
      }),
    ).toEqual({
      status: "healthy",
      checkedAt: "2026-09-01T15:41:00.000Z",
      roundIntervalMinutes: 25,
      delayThresholdSeconds: 7_200,
      latestRoundNumber: 2131,
      latestActivityAt: "2026-09-01T15:30:00.000Z",
      secondsSinceLatestActivity: 660,
      latestObservedGap: {
        fromRoundNumber: 2119,
        toRoundNumber: 2120,
        fromCompletedAt: "2026-08-31T17:04:23.000Z",
        toCreatedAt: "2026-09-01T07:00:06.000Z",
        gapSeconds: 50_143,
      },
    });
  });

  test("marks an unpaused league delayed after the conservative liveness window", () => {
    expect(
      evaluateCoworldLeagueSchedulerHealth({
        rounds: recoveredRounds.slice(0, 2),
        roundsPausedAt: null,
        roundIntervalMinutes: 25,
        checkedAt: "2026-09-01T10:00:01.000Z",
      }).status,
    ).toBe("delayed");
  });

  test("an explicit hosted pause overrides silence", () => {
    expect(
      evaluateCoworldLeagueSchedulerHealth({
        rounds: recoveredRounds.slice(0, 2),
        roundsPausedAt: "2026-09-01T07:30:00.000Z",
        roundIntervalMinutes: 25,
        checkedAt: "2026-09-01T20:00:00.000Z",
      }).status,
    ).toBe("paused");
  });

  test("missing cadence or round evidence is unavailable, never delayed", () => {
    expect(
      evaluateCoworldLeagueSchedulerHealth({
        rounds: [],
        roundsPausedAt: null,
        roundIntervalMinutes: null,
        checkedAt: "2026-09-01T20:00:00.000Z",
      }).status,
    ).toBe("unavailable");
  });
});
