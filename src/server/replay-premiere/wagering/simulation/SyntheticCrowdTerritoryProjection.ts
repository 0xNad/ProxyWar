/**
 * Whole-match, per-seat territory precompute for the synthetic crowd.
 *
 * A replay premiere is a replay of an ALREADY-COMPLETED match: every turn's
 * tile ownership is knowable the moment the match is sealed, without
 * running anything in lockstep with the live release clock. This module
 * runs the real deterministic game engine (`src/core`'s `GameRunner`, via
 * `createGameRunner` — the exact same entry point
 * `ReplayPremiereCheckpointProjection.ts` already uses for the two
 * publication checkpoints, and `strictGateBoundTurns` for the exact same
 * chunk-hash-verified turn extraction) ONCE, replays the whole sealed
 * bundle, and records each seat's `numTilesOwned()` at a coarse interval.
 * Zero diff to `src/core` — this only calls its existing read API.
 *
 * Why precompute instead of a live GameRunner ticking alongside the
 * release clock: no per-match memory/CPU for the live process duration, no
 * lifecycle to manage, no failure mode where a live engine falls behind
 * the release clock and the crowd silently drifts, and the result is a
 * plain, inspectable table a test can assert against directly.
 *
 * Integrity: the resulting table spans the WHOLE match, including
 * everything not yet released — outcome-bearing by construction. It MUST
 * live server-side only. `SyntheticCrowdLiveDriver` is the only reader,
 * and it is structurally bounded to look up a row at or before the
 * highest sequence `readLiveProjection` has actually released (see
 * `syntheticCrowdTerritorySampleAtOrBefore`) — never ahead of it. The
 * table itself never reaches `SyntheticCrowdSimulator`, any bot, or any
 * client; only the one row-per-poll the driver derives from it does,
 * exactly like every other input this driver hands the simulator.
 */
import type { GameUpdateViewData, ErrorUpdate } from "../../../../core/game/GameUpdates";
import { GameUpdateType } from "../../../../core/game/GameUpdates";
import type { GameMapLoader } from "../../../../core/game/GameMapLoader";
import { createGameRunner } from "../../../../core/GameRunner";
import type { GameStartInfo, Turn } from "../../../../core/Schemas";
import {
  ReplayPremiereFilesystemMapLoader,
  strictGateBoundTurns,
} from "../../ReplayPremiereCheckpointProjection";
import type { PremiereChunkDraft } from "../../ReplayPremiereContracts";
import type { VerifiedPremiereEligibilityGate } from "../../ReplayPremierePublication";

/**
 * ~1 second of match content at the real OpenFront cadence (100ms/turn —
 * see `ReplayPremiereContracts.ts`'s `turnIntervalMs` note), which is also
 * this driver's own default poll cadence: fine enough that the signal the
 * crowd trades on moves at the same grain it's sampled, coarse enough that
 * even a long (tens-of-thousands-of-turns) match produces a table of a
 * few thousand rows — trivially small to hold in memory for one premiere.
 */
export const SYNTHETIC_CROWD_TERRITORY_SAMPLE_INTERVAL_TURNS = 10;

export interface SyntheticCrowdTerritorySample {
  readonly sequence: number;
  /** Per-seat tile count as of this turn. A seat absent from provenance, never spawned, or eliminated reads 0 — never omitted. */
  readonly tilesOwned: Readonly<Record<string, number>>;
}

export interface SyntheticCrowdTerritoryTable {
  readonly samples: readonly SyntheticCrowdTerritorySample[];
}

export interface SyntheticCrowdTerritoryProjector {
  project(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    seatIds: readonly string[];
    signal: AbortSignal;
  }): Promise<SyntheticCrowdTerritoryTable>;
}

/**
 * The latest sample at or before `maxSequence`, or `null` if released
 * content hasn't reached the table's first sample yet (or the table is
 * empty). NEVER returns a sample past `maxSequence` — the one integrity
 * rule this table exists under; every caller MUST pass the highest
 * sequence actually released so far, never anything higher.
 */
export function syntheticCrowdTerritorySampleAtOrBefore(
  table: SyntheticCrowdTerritoryTable,
  maxSequence: number,
): SyntheticCrowdTerritorySample | null {
  const samples = table.samples;
  if (samples.length === 0 || samples[0].sequence > maxSequence) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (samples[mid].sequence <= maxSequence) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return samples[lo];
}

export class DeterministicSyntheticCrowdTerritoryProjector
  implements SyntheticCrowdTerritoryProjector
{
  private readonly resourcesMapsRoot: string;

  constructor(resourcesMapsRoot: string) {
    this.resourcesMapsRoot = resourcesMapsRoot;
  }

  async project(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    seatIds: readonly string[];
    signal: AbortSignal;
  }): Promise<SyntheticCrowdTerritoryTable> {
    const turns = await strictGateBoundTurns(
      options.gate,
      options.drafts,
      options.gate.finalSequence,
      options.signal,
    );
    return projectSyntheticCrowdTerritorySamples({
      gameStartInfo: options.gate.publicBootstrap(),
      turns,
      seatIds: options.seatIds,
      mapLoader: new ReplayPremiereFilesystemMapLoader(this.resourcesMapsRoot),
      signal: options.signal,
    });
  }
}

/** Real-engine sampling pass — exported standalone for direct testing without a gate/draft fixture. */
export async function projectSyntheticCrowdTerritorySamples(options: {
  gameStartInfo: GameStartInfo;
  turns: readonly Turn[];
  seatIds: readonly string[];
  mapLoader: GameMapLoader;
  signal: AbortSignal;
}): Promise<SyntheticCrowdTerritoryTable> {
  const hashes = new Map<number, number>();
  let runnerError: ErrorUpdate | null = null;
  const runner = await createGameRunner(
    options.gameStartInfo,
    undefined,
    options.mapLoader,
    (update: GameUpdateViewData | ErrorUpdate) => {
      if ("errMsg" in update) {
        runnerError = update;
        return;
      }
      for (const hash of update.updates[GameUpdateType.Hash]) {
        if (hashes.has(hash.tick)) {
          runnerError = { errMsg: "duplicate deterministic hash update" };
          return;
        }
        hashes.set(hash.tick, hash.hash);
      }
    },
  );

  const samples: SyntheticCrowdTerritorySample[] = [];
  const recordSample = (sequence: number) => {
    const tilesOwned: Record<string, number> = {};
    for (const seatId of options.seatIds) {
      const player = runner.game.playerByClientID(seatId);
      tilesOwned[seatId] = player === null ? 0 : player.numTilesOwned();
    }
    samples.push({ sequence, tilesOwned: Object.freeze(tilesOwned) });
  };

  const lastTurnNumber = options.turns.at(-1)?.turnNumber ?? -1;
  for (const turn of options.turns) {
    if (options.signal.aborted) {
      throw new Error("synthetic_crowd_territory_projection_aborted");
    }
    // Pause toggles are a UI-only control, never real game input — the
    // checkpoint projector strips them for the identical reason before
    // replaying a turn.
    const replayTurn = turn.intents.some((intent) => intent.type === "toggle_pause")
      ? { ...turn, intents: turn.intents.filter((intent) => intent.type !== "toggle_pause") }
      : turn;
    runner.addTurn(replayTurn);
    if (!runner.executeNextTick() || runnerError !== null) {
      throw new Error("synthetic_crowd_territory_projection_turn_execution_failed");
    }
    if (turn.hash !== undefined && turn.hash !== null) {
      const projectedHash = hashes.get(turn.turnNumber);
      if (projectedHash === undefined || projectedHash !== turn.hash) {
        throw new Error("synthetic_crowd_territory_projection_archived_hash_mismatch");
      }
    }
    if (
      turn.turnNumber % SYNTHETIC_CROWD_TERRITORY_SAMPLE_INTERVAL_TURNS === 0 ||
      turn.turnNumber === lastTurnNumber
    ) {
      recordSample(turn.turnNumber);
    }
    if (turn.turnNumber > 0 && turn.turnNumber % 256 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (samples.length === 0) recordSample(0);
  return { samples: Object.freeze(samples) };
}
