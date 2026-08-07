import { isValidSpawnSite } from "../../core/execution/Util";
import { Game } from "../../core/game/Game";
import { SpawnCandidate } from "./LegalActionBuilder";

/**
 * Minimum acceptable `localLandScore` (the land-ratio quality metric
 * `buildSpawnCandidates` already computes for every candidate - land tiles
 * / total tiles in a disk of radius ~9.6% of the map's shorter dimension,
 * the SAME metric already weighted 0.5 in the existing composite quality
 * sort) a candidate must clear before it is eligible to become a fairness
 * slot. No new quality model: this reuses the exact existing signal that
 * already penalizes tiny islands and thin/bad coastlines, just applied as a
 * hard floor instead of a soft weight.
 */
export const DEFAULT_SPAWN_QUALITY_FLOOR = 0.5;

export interface SelectSpawnSlotsOptions {
  qualityFloor?: number;
}

/**
 * Deterministically selects exactly `slotCount` well-spaced, quality-floored
 * spawn candidates via greedy maximin (farthest-point) sampling:
 *
 *  1. QUALITY FLOOR (applied BEFORE spacing, so a tiny-island/bad-coastline
 *     candidate can never win purely by being far from everything else):
 *     keep only candidates whose `localLandScore >= qualityFloor`.
 *  2. FIRST SEED: the single highest-`localLandScore` qualifying candidate
 *     (ties -> lowest tile ID). An authoritative, explainable starting
 *     point - reusing the same quality signal as the floor, never an
 *     arbitrary array-order or geometric pick.
 *  3. Repeatedly add the qualifying candidate whose distance to its NEAREST
 *     already-selected slot is largest (ties -> lowest tile ID), using
 *     Euclidean distance - the same metric this codebase already uses for
 *     spawn-candidate spacing (`distanceBetweenCandidates` in
 *     AgentLeagueMatch.ts) - until `slotCount` slots are chosen.
 *
 * Throws with a specific, actionable message if fewer than `slotCount`
 * candidates pass the quality floor - insufficiency fails loudly, it is
 * never silently absorbed into an unfair (too-close or low-quality) slot.
 *
 * Returns the `slotCount` selected candidates sorted by ascending tile ID -
 * a stable, reproducible order independent of selection order or of the
 * input array's own ordering, so `spawnSlotForRosterIndex` is reproducible
 * regardless of incidental upstream iteration order.
 */
export function selectSpawnSlots(
  candidates: readonly SpawnCandidate[],
  slotCount: number,
  options: SelectSpawnSlotsOptions = {},
): SpawnCandidate[] {
  if (!Number.isInteger(slotCount) || slotCount <= 0) {
    throw new Error(
      `selectSpawnSlots: slotCount must be a positive integer, got ${slotCount}`,
    );
  }
  const qualityFloor = options.qualityFloor ?? DEFAULT_SPAWN_QUALITY_FLOOR;

  const qualified = candidates.filter((candidate) => {
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      throw new Error(
        `selectSpawnSlots: candidate at tile ${candidate.tile} is missing x/y coordinates`,
      );
    }
    return (candidate.localLandScore ?? 0) >= qualityFloor;
  });

  if (qualified.length < slotCount) {
    throw new Error(
      `selectSpawnSlots: only ${qualified.length} candidate(s) pass the quality floor ` +
        `(localLandScore >= ${qualityFloor}) out of ${candidates.length} offered, but ` +
        `${slotCount} slot(s) are required. Widen the candidate pool ` +
        "(buildSpawnCandidates maxCandidates/stride) or lower the quality floor - " +
        "never silently fall back to a lower-quality or overlapping slot.",
    );
  }

  let seed = qualified[0];
  for (const candidate of qualified) {
    const seedScore = seed.localLandScore ?? 0;
    const candidateScore = candidate.localLandScore ?? 0;
    if (
      candidateScore > seedScore ||
      (candidateScore === seedScore && candidate.tile < seed.tile)
    ) {
      seed = candidate;
    }
  }

  const selected: SpawnCandidate[] = [seed];
  // Running "distance to nearest selected slot" per not-yet-selected
  // qualifying candidate - classic farthest-point sampling: O(slotCount *
  // qualified.length) total instead of O(slotCount^2 * qualified.length)
  // from recomputing every candidate's nearest-selected distance from
  // scratch each round.
  const nearestSelectedDistance = new Map<number, number>();
  for (const candidate of qualified) {
    if (candidate.tile === seed.tile) {
      continue;
    }
    nearestSelectedDistance.set(candidate.tile, spawnDistance(candidate, seed));
  }

  while (selected.length < slotCount) {
    let best: SpawnCandidate | null = null;
    let bestDistance = -Infinity;
    for (const candidate of qualified) {
      const distance = nearestSelectedDistance.get(candidate.tile);
      if (distance === undefined) {
        // Already selected (removed from the map below) - skip.
        continue;
      }
      if (
        distance > bestDistance ||
        (distance === bestDistance && best !== null && candidate.tile < best.tile)
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best === null) {
      // Unreachable given the qualified.length >= slotCount guard above,
      // but fail clearly rather than silently returning a short list.
      throw new Error(
        "selectSpawnSlots: ran out of qualifying candidates during maximin selection",
      );
    }
    selected.push(best);
    nearestSelectedDistance.delete(best.tile);
    for (const candidate of qualified) {
      const previous = nearestSelectedDistance.get(candidate.tile);
      if (previous === undefined) {
        continue;
      }
      const distance = spawnDistance(candidate, best);
      if (distance < previous) {
        nearestSelectedDistance.set(candidate.tile, distance);
      }
    }
  }

  return selected.sort((a, b) => a.tile - b.tile);
}

/**
 * Assigns roster participant `rosterIndex` (0-based, array position in the
 * league's participant roster) to a slot for `episodeIndex` (0-based ordinal
 * of this episode among repeated episodes reusing the SAME slot set):
 * `slots[(rosterIndex + episodeIndex) % slots.length]`. Over `slots.length`
 * consecutive episodes (episodeIndex = 0, 1, ..., N-1) every roster position
 * visits every slot exactly once - modular rotation is a permutation of
 * 0..N-1 for each fixed rosterIndex.
 */
export function spawnSlotForRosterIndex(
  slots: readonly SpawnCandidate[],
  rosterIndex: number,
  episodeIndex: number,
): SpawnCandidate {
  const n = slots.length;
  if (n === 0) {
    throw new Error("spawnSlotForRosterIndex: slots must be non-empty");
  }
  if (!Number.isInteger(rosterIndex) || rosterIndex < 0) {
    throw new Error(
      `spawnSlotForRosterIndex: rosterIndex must be a non-negative integer, got ${rosterIndex}`,
    );
  }
  if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
    throw new Error(
      `spawnSlotForRosterIndex: episodeIndex must be a non-negative integer, got ${episodeIndex}`,
    );
  }
  return slots[(rosterIndex + episodeIndex) % n];
}

export interface AssignSpawnSlotsInput {
  candidates: readonly SpawnCandidate[];
  participantCount: number;
  /** Zero-based episode ordinal for slot rotation. Default 0. */
  episodeIndex?: number;
  qualityFloor?: number;
}

/**
 * Convenience wrapper composing `selectSpawnSlots` + `spawnSlotForRosterIndex`:
 * returns an array of length `participantCount` where index `i` is the slot
 * assigned to roster participant `i`.
 */
export function assignSpawnSlots(
  input: AssignSpawnSlotsInput,
): SpawnCandidate[] {
  const slots = selectSpawnSlots(input.candidates, input.participantCount, {
    qualityFloor: input.qualityFloor,
  });
  const episodeIndex = input.episodeIndex ?? 0;
  return Array.from({ length: input.participantCount }, (_, rosterIndex) =>
    spawnSlotForRosterIndex(slots, rosterIndex, episodeIndex),
  );
}

/**
 * Integrity guard, ALWAYS callable (no live game needed): the maximin
 * selection in `selectSpawnSlots` must never repeat a tile across the
 * assigned slots. Throws immediately, naming the offending agent and tile,
 * if it ever does - a duplicate here means a bug in the selection
 * algorithm, never something to submit and silently let core sort out.
 */
export function validateSpawnSlotUniqueness(
  assignment: readonly SpawnCandidate[],
  agentIDs: readonly string[],
): void {
  const seenBy = new Map<number, string>();
  for (let i = 0; i < assignment.length; i += 1) {
    const tile = assignment[i].tile;
    const agentID = agentIDs[i] ?? `roster[${i}]`;
    const owner = seenBy.get(tile);
    if (owner !== undefined) {
      throw new Error(
        `validateSpawnSlotUniqueness: tile ${tile} is assigned to both ` +
          `${owner} and ${agentID} - maximin selection must never repeat a slot`,
      );
    }
    seenBy.set(tile, agentID);
  }
}

/**
 * Authoritative pre-submit legality guard against LIVE game state: re-checks
 * every assigned slot with the exact same core predicates `buildSpawnCandidates`
 * used at generation time (isValidRef, isLand, !hasOwner, !isBorder,
 * isValidSpawnSite - src/core/game/GameMap.ts / src/core/execution/Util.ts),
 * against the CURRENT `gameState` rather than trusting the candidate pool's
 * scores at face value. Catches a stale/mismatched candidate pool or a tile
 * some other player has since claimed. Throws immediately, naming the
 * offending agent/tile/reason, on any violation - never silently
 * substitutes a different tile or lets the submission proceed.
 */
export function validateSpawnSlotLegality(
  assignment: readonly SpawnCandidate[],
  agentIDs: readonly string[],
  gameState: Game,
): void {
  for (let i = 0; i < assignment.length; i += 1) {
    const tile = assignment[i].tile;
    const agentID = agentIDs[i] ?? `roster[${i}]`;
    if (!gameState.isValidRef(tile)) {
      throw new Error(
        `validateSpawnSlotLegality: agent ${agentID}'s assigned tile ${tile} is out of bounds`,
      );
    }
    if (!gameState.isLand(tile)) {
      throw new Error(
        `validateSpawnSlotLegality: agent ${agentID}'s assigned tile ${tile} is not land`,
      );
    }
    if (gameState.hasOwner(tile)) {
      throw new Error(
        `validateSpawnSlotLegality: agent ${agentID}'s assigned tile ${tile} is already occupied`,
      );
    }
    if (gameState.isBorder(tile)) {
      throw new Error(
        `validateSpawnSlotLegality: agent ${agentID}'s assigned tile ${tile} borders a claimed territory`,
      );
    }
    if (!isValidSpawnSite(gameState, tile)) {
      throw new Error(
        `validateSpawnSlotLegality: agent ${agentID}'s assigned tile ${tile}'s ` +
          "surrounding spawn footprint is not fully valid land",
      );
    }
  }
}

function spawnDistance(a: SpawnCandidate, b: SpawnCandidate): number {
  return Math.hypot((a.x as number) - (b.x as number), (a.y as number) - (b.y as number));
}
