/**
 * Spawn-aware checkpoint placement for pre-simulated premiere-wagering
 * episodes.
 *
 * BUG THIS FILE EXISTS TO AVOID: both `replay-premiere-ingest-coworld.ts`
 * (`suggestedCheckpointSequences`) and `ReplayPremiereLoopCore.ts`
 * (`checkpointSequencesForTurnCount`) place the two checkpoints at
 * `round(0.35 * turnCount)` / `round(0.65 * turnCount)` — fractions of the
 * WHOLE match, measured from turn 0. That is silently wrong for any episode
 * whose turn count is not much larger than the spawn phase: a real spawn
 * phase runs 100 (Singleplayer), 150 (random spawn) or 300 (fixed spawn)
 * turns (`src/core/configuration/DefaultConfig.ts:609` — read-only reference,
 * never imported here, src/core stays untouched) before any seat has
 * committed a nation. A short/micro-variant episode (the kind the platform
 * has actually run — see `docs/project-state/softmax-platform-feedback.md`
 * item 14's "MICRO variant, 2 decision steps x 25 turns") can have
 * `0.35 * turnCount` land INSIDE the spawn phase: seats aren't even settled
 * yet, so "stake on a seat's territory share" is meaningless and the market
 * is staking on an artifact of spawn RNG, not gameplay.
 *
 * The fix: compute the two fractions over the MEANINGFUL (post-spawn)
 * window, then offset back by the spawn length.
 *
 *   meaningfulTurns = turnCount - spawnPhaseTurns
 *   checkpoint[i]   = spawnPhaseTurns + round(fraction[i] * meaningfulTurns)
 */

/** Same three constants as `DefaultConfig.numSpawnPhaseTurns()` — duplicated
 * deliberately (never import src/core here) but numerically pinned to it. */
export const SPAWN_PHASE_TURNS_SINGLEPLAYER = 100;
export const SPAWN_PHASE_TURNS_RANDOM_SPAWN = 150;
export const SPAWN_PHASE_TURNS_FIXED_SPAWN = 300;

export const PREMIERE_WAGERING_CHECKPOINT_FRACTIONS = [0.35, 0.65] as const;

export interface EpisodeSpawnConfig {
  /** `info.config.gameType` from the game record, e.g. "Private" | "Public" | "Singleplayer". */
  readonly gameType: string;
  /** `info.config.randomSpawn` from the game record. */
  readonly randomSpawn: boolean;
}

/**
 * Turns the spawn phase runs for, mirroring
 * `DefaultConfig.numSpawnPhaseTurns()` exactly (core is the source of truth;
 * this is a read-only numeric mirror so scripts/ never has to import the
 * simulation engine to place a checkpoint).
 */
export function spawnPhaseTurnCount(config: EpisodeSpawnConfig): number {
  if (config.gameType === "Singleplayer") {
    return SPAWN_PHASE_TURNS_SINGLEPLAYER;
  }
  if (config.randomSpawn) {
    return SPAWN_PHASE_TURNS_RANDOM_SPAWN;
  }
  return SPAWN_PHASE_TURNS_FIXED_SPAWN;
}

export class PremiereWageringCheckpointError extends Error {}

/**
 * The two checkpoint turn numbers, at ~35% and ~65% of the POST-SPAWN
 * window. Throws if the episode is too short to place two distinct
 * post-spawn checkpoints strictly before the final turn (a real integrity
 * failure — never silently clamp two checkpoints on top of each other or
 * past the end of the match).
 */
export function checkpointTurnsForEpisode(input: {
  readonly turnCount: number;
  readonly spawn: EpisodeSpawnConfig;
}): readonly [number, number] {
  const { turnCount } = input;
  if (!Number.isSafeInteger(turnCount) || turnCount <= 0) {
    throw new PremiereWageringCheckpointError(
      `turnCount must be a positive integer, got ${turnCount}`,
    );
  }
  const spawnPhaseTurns = spawnPhaseTurnCount(input.spawn);
  const meaningfulTurns = turnCount - spawnPhaseTurns;
  if (meaningfulTurns <= 0) {
    throw new PremiereWageringCheckpointError(
      `episode has ${turnCount} turn(s), all inside the ${spawnPhaseTurns}-turn spawn phase; no post-spawn window to checkpoint`,
    );
  }
  const [firstFraction, secondFraction] =
    PREMIERE_WAGERING_CHECKPOINT_FRACTIONS;
  const first = spawnPhaseTurns + Math.round(firstFraction * meaningfulTurns);
  const second =
    spawnPhaseTurns + Math.round(secondFraction * meaningfulTurns);
  if (
    first <= spawnPhaseTurns ||
    second <= first ||
    second >= turnCount
  ) {
    throw new PremiereWageringCheckpointError(
      `episode has ${turnCount} turn(s) (spawn phase ${spawnPhaseTurns}); computed checkpoints [${first}, ${second}] are not strictly ordered inside the post-spawn window`,
    );
  }
  return [first, second];
}

/**
 * The SAME computation `replay-premiere-ingest-coworld.ts` and
 * `ReplayPremiereLoopCore.ts` currently use — `round(fraction * turnCount)`
 * from turn 0, ignoring the spawn phase entirely. Exported only so tests (and
 * the sealing CLI's report output) can show the two formulas side by side on
 * a real episode; production checkpoint placement must always go through
 * `checkpointTurnsForEpisode` above, never this one.
 */
export function naiveTurnZeroCheckpoints(
  turnCount: number,
): readonly [number, number] {
  const [firstFraction, secondFraction] =
    PREMIERE_WAGERING_CHECKPOINT_FRACTIONS;
  return [
    Math.round(firstFraction * turnCount),
    Math.round(secondFraction * turnCount),
  ];
}
