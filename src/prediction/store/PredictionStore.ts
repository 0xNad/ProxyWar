/**
 * Storage abstraction — SPEC §8.
 *
 * The seam a v2 backend slots into without touching feature code. All writes
 * are idempotent by `(fixtureId, checkpointIndex, kind)` (the same key
 * `marketId()` builds) so a refresh mid-action cannot double-stake or
 * double-pay.
 *
 * Extends the spec's minimal snippet with:
 *  - `loadSeenFixtureIds`/`markFixtureSeen`: SPEC §2.1 requires
 *    `seenFixtureIds` to survive season resets and live in "the storage
 *    abstraction", so it belongs on this interface rather than folded into
 *    `Season`.
 *  - `loadClosedCheckpoints`/`recordCheckpointClosed`: SPEC §9's "no staking
 *    after a checkpoint closes" must survive a refresh even when the player
 *    staked nothing at that checkpoint, so closure cannot be inferred from
 *    stake presence (that inference is a confirmed reload exploit — open a
 *    checkpoint, stake nothing, watch the reveal, reload, and an
 *    inference-based check reopens it with the outcome already seen).
 *    Closure is a fact about what the player has been shown, monotonic
 *    (never un-recorded), tracked per fixture independent of markets/stakes.
 */
import type {
  CheckpointIndex,
  FixtureId,
  Resolution,
  Season,
  SeasonSummary,
  Stake,
} from "../types";

export interface PredictionStore {
  loadSeason(): Promise<Season | null>;
  saveSeason(season: Season): Promise<void>;
  listSeasons(): Promise<SeasonSummary[]>;
  recordStake(stake: Stake): Promise<void>;
  recordResolution(resolution: Resolution): Promise<void>;
  loadSeenFixtureIds(): Promise<ReadonlySet<FixtureId>>;
  markFixtureSeen(fixtureId: FixtureId): Promise<void>;
  loadClosedCheckpoints(fixtureId: FixtureId): Promise<readonly CheckpointIndex[]>;
  recordCheckpointClosed(fixtureId: FixtureId, checkpointIndex: CheckpointIndex): Promise<void>;
}
