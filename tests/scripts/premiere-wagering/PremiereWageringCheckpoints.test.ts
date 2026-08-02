import { describe, expect, test } from "vitest";
import {
  checkpointTurnsForEpisode,
  naiveTurnZeroCheckpoints,
  PremiereWageringCheckpointError,
  spawnPhaseTurnCount,
  SPAWN_PHASE_TURNS_FIXED_SPAWN,
  SPAWN_PHASE_TURNS_RANDOM_SPAWN,
  SPAWN_PHASE_TURNS_SINGLEPLAYER,
} from "../../../src/scripts/premiere-wagering/PremiereWageringCheckpoints";

describe("spawnPhaseTurnCount", () => {
  test("Singleplayer is 100 turns regardless of randomSpawn", () => {
    expect(
      spawnPhaseTurnCount({ gameType: "Singleplayer", randomSpawn: true }),
    ).toBe(SPAWN_PHASE_TURNS_SINGLEPLAYER);
    expect(
      spawnPhaseTurnCount({ gameType: "Singleplayer", randomSpawn: false }),
    ).toBe(SPAWN_PHASE_TURNS_SINGLEPLAYER);
  });

  test("non-Singleplayer with randomSpawn is 150 turns", () => {
    expect(
      spawnPhaseTurnCount({ gameType: "Private", randomSpawn: true }),
    ).toBe(SPAWN_PHASE_TURNS_RANDOM_SPAWN);
  });

  test("non-Singleplayer with fixed spawn is 300 turns", () => {
    expect(
      spawnPhaseTurnCount({ gameType: "Private", randomSpawn: false }),
    ).toBe(SPAWN_PHASE_TURNS_FIXED_SPAWN);
    expect(
      spawnPhaseTurnCount({ gameType: "Public", randomSpawn: false }),
    ).toBe(SPAWN_PHASE_TURNS_FIXED_SPAWN);
  });
});

describe("checkpointTurnsForEpisode — verified against a real episode", () => {
  // artifacts/ai-league-runs/league-coworld-2026-07-26T09-12-41-706Z-ea6da6f4:
  // a genuine mirrored Coworld episode. game-record.json: num_turns=10500,
  // config.gameType="Private", config.randomSpawn=false.
  test("real episode: 10500 turns, Private, fixed spawn -> spawn phase 300, checkpoints post-spawn", () => {
    const [first, second] = checkpointTurnsForEpisode({
      turnCount: 10500,
      spawn: { gameType: "Private", randomSpawn: false },
    });
    const spawnPhaseTurns = 300;
    const meaningfulTurns = 10500 - spawnPhaseTurns;
    expect(first).toBe(spawnPhaseTurns + Math.round(0.35 * meaningfulTurns));
    expect(second).toBe(spawnPhaseTurns + Math.round(0.65 * meaningfulTurns));
    expect(first).toBe(3870);
    expect(second).toBe(6930);
    expect(first).toBeGreaterThan(spawnPhaseTurns);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(10500);
  });

  test("the bug this avoids: a short/micro-variant episode places the naive checkpoint inside the spawn phase, this one does not", () => {
    // docs/project-state/softmax-platform-feedback.md item 14 describes a
    // real MICRO league variant: "2 decision steps x 25 turns" — a genuinely
    // short episode this platform has actually run. 60 turns with a fixed
    // (non-random) spawn is representative: spawn phase alone is 300 turns
    // in DefaultConfig, i.e. longer than the whole match, so there is no
    // post-spawn window at all and placement must refuse rather than lie.
    const turnCount = 60;
    const naive = naiveTurnZeroCheckpoints(turnCount);
    // The naive (turn-0-relative) formula the ingest script and
    // ReplayPremiereLoopCore currently use lands both checkpoints inside
    // what would be a 300-turn spawn phase.
    expect(naive[0]).toBeLessThan(SPAWN_PHASE_TURNS_FIXED_SPAWN);
    expect(naive[1]).toBeLessThan(SPAWN_PHASE_TURNS_FIXED_SPAWN);
    expect(() =>
      checkpointTurnsForEpisode({
        turnCount,
        spawn: { gameType: "Private", randomSpawn: false },
      }),
    ).toThrow(PremiereWageringCheckpointError);
  });

  test("a short episode WITH enough post-spawn turns still places both checkpoints strictly after the spawn phase", () => {
    // 900 turns, fixed spawn (300 turns) -> 600 meaningful turns.
    const [first, second] = checkpointTurnsForEpisode({
      turnCount: 900,
      spawn: { gameType: "Private", randomSpawn: false },
    });
    expect(first).toBe(300 + Math.round(0.35 * 600)); // 300 + 210 = 510
    expect(second).toBe(300 + Math.round(0.65 * 600)); // 300 + 390 = 690
    expect(first).toBeGreaterThan(300);
    // Contrast with the naive formula, which would place checkpoint 1 at
    // round(0.35*900)=315 — barely past the spawn boundary and nowhere near
    // where 35% of the ACTUAL game should be evaluated.
    const naive = naiveTurnZeroCheckpoints(900);
    expect(naive[0]).not.toBe(first);
  });

  test("rejects non-positive or non-integer turn counts", () => {
    expect(() =>
      checkpointTurnsForEpisode({
        turnCount: 0,
        spawn: { gameType: "Private", randomSpawn: false },
      }),
    ).toThrow(PremiereWageringCheckpointError);
    expect(() =>
      checkpointTurnsForEpisode({
        turnCount: 10.5,
        spawn: { gameType: "Private", randomSpawn: false },
      }),
    ).toThrow(PremiereWageringCheckpointError);
  });
});
