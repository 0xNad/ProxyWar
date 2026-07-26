/**
 * In-memory `PredictionStore` — SPEC §8. Same idempotency contract as the
 * IndexedDB implementation; used by tests and as a fallback where IndexedDB
 * is unavailable.
 */
import type {
  CheckpointIndex,
  FixtureId,
  Resolution,
  Season,
  Stake,
} from "../types";
import { marketId } from "../types";
import { resolutionsEqual, stakesEqual } from "../engine/ledger";
import { summarizeSeason } from "../engine/summary";
import type { PredictionStore } from "./PredictionStore";

export function createMemoryPredictionStore(): PredictionStore {
  const seasons = new Map<number, Season>();
  const stakes = new Map<string, Stake>();
  const resolutions = new Map<string, Resolution>();
  let seenFixtureIds = new Set<FixtureId>();
  const closedCheckpoints = new Map<FixtureId, Set<CheckpointIndex>>();

  return {
    async loadSeason() {
      if (seasons.size === 0) return null;
      return [...seasons.values()].reduce((latest, s) =>
        s.index > latest.index ? s : latest,
      );
    },

    async saveSeason(season) {
      seasons.set(season.index, season);
    },

    async listSeasons() {
      return [...seasons.values()]
        .sort((a, b) => a.index - b.index)
        .map(summarizeSeason);
    },

    async recordStake(stake) {
      const key = marketId(stake.fixtureId, stake.checkpointIndex, stake.kind);
      const existing = stakes.get(key);
      if (existing !== undefined) {
        if (stakesEqual(existing, stake)) return;
        throw new Error(
          `recordStake: market ${key} already has a different stake recorded`,
        );
      }
      stakes.set(key, stake);
    },

    async recordResolution(resolution) {
      const key = marketId(
        resolution.fixtureId,
        resolution.checkpointIndex,
        resolution.kind,
      );
      const existing = resolutions.get(key);
      if (existing !== undefined) {
        if (resolutionsEqual(existing, resolution)) return;
        throw new Error(
          `recordResolution: market ${key} already has a different resolution recorded`,
        );
      }
      resolutions.set(key, resolution);
    },

    async loadSeenFixtureIds() {
      return new Set(seenFixtureIds);
    },

    async markFixtureSeen(fixtureId) {
      seenFixtureIds = new Set(seenFixtureIds).add(fixtureId);
    },

    async loadClosedCheckpoints(fixtureId) {
      return [...(closedCheckpoints.get(fixtureId) ?? [])];
    },

    async recordCheckpointClosed(fixtureId, checkpointIndex) {
      const existing = closedCheckpoints.get(fixtureId) ?? new Set<CheckpointIndex>();
      closedCheckpoints.set(fixtureId, new Set(existing).add(checkpointIndex));
    },
  };
}
