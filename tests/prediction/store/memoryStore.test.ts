/**
 * Unit tests for src/prediction/store/memoryStore.ts — SPEC §8: idempotent
 * writes by (fixtureId, checkpointIndex, kind), refresh-safety, and the
 * seenFixtureIds persistence this task adds beyond the spec's minimal
 * interface snippet.
 */
import { describe, expect, it } from "vitest";

import { createMemoryPredictionStore } from "../../../src/prediction/store/memoryStore";
import {
  STARTING_BANKROLL,
  type Resolution,
  type Season,
  type Stake,
} from "../../../src/prediction/types";

function makeStake(overrides: Partial<Stake> = {}): Stake {
  return {
    fixtureId: "fx-1",
    checkpointIndex: 0,
    kind: "winner",
    seatId: "a",
    amount: 50,
    multiplierBp: 15_000,
    placedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    fixtureId: "fx-1",
    checkpointIndex: 0,
    kind: "winner",
    state: "won",
    returned: 75,
    resolvedAtIso: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    index: 0,
    fixtureIds: ["fx-1"],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createMemoryPredictionStore() — season persistence", () => {
  it("loadSeason() is null before anything is saved", async () => {
    const store = createMemoryPredictionStore();
    expect(await store.loadSeason()).toBeNull();
  });

  it("saveSeason() then loadSeason() round-trips (refresh-safety)", async () => {
    const store = createMemoryPredictionStore();
    const season = makeSeason({ bankroll: 940 });
    await store.saveSeason(season);
    expect(await store.loadSeason()).toEqual(season);
  });

  it("loadSeason() returns the highest-index season across multiple saves", async () => {
    const store = createMemoryPredictionStore();
    await store.saveSeason(makeSeason({ index: 0 }));
    await store.saveSeason(makeSeason({ index: 1 }));
    await store.saveSeason(makeSeason({ index: 2 }));
    expect((await store.loadSeason())?.index).toBe(2);
  });

  it("saveSeason() is an upsert by index — re-saving the same index overwrites, not duplicates", async () => {
    const store = createMemoryPredictionStore();
    await store.saveSeason(makeSeason({ index: 0, bankroll: 1_000 }));
    await store.saveSeason(makeSeason({ index: 0, bankroll: 500 }));
    expect(await store.listSeasons()).toHaveLength(1);
    expect((await store.loadSeason())?.bankroll).toBe(500);
  });

  it("listSeasons() returns summaries for every saved season, sorted by index", async () => {
    const store = createMemoryPredictionStore();
    await store.saveSeason(makeSeason({ index: 1, bankroll: 200 }));
    await store.saveSeason(makeSeason({ index: 0, bankroll: 1_000 }));
    const summaries = await store.listSeasons();
    expect(summaries.map((s) => s.index)).toEqual([0, 1]);
    expect(summaries[1].finalBankroll).toBe(200);
  });
});

describe("createMemoryPredictionStore() — recordStake idempotency", () => {
  it("accepts a stake once", async () => {
    const store = createMemoryPredictionStore();
    await expect(store.recordStake(makeStake())).resolves.toBeUndefined();
  });

  it("replaying the identical stake is a silent no-op (refresh mid-action)", async () => {
    const store = createMemoryPredictionStore();
    const stake = makeStake();
    await store.recordStake(stake);
    await expect(store.recordStake(stake)).resolves.toBeUndefined();
    await expect(store.recordStake({ ...stake })).resolves.toBeUndefined();
  });

  it("rejects a different stake for an already-recorded market key", async () => {
    const store = createMemoryPredictionStore();
    await store.recordStake(makeStake({ amount: 50 }));
    await expect(store.recordStake(makeStake({ amount: 60 }))).rejects.toThrow();
  });
});

describe("createMemoryPredictionStore() — recordResolution idempotency", () => {
  it("accepts a resolution once", async () => {
    const store = createMemoryPredictionStore();
    await expect(store.recordResolution(makeResolution())).resolves.toBeUndefined();
  });

  it("replaying the identical resolution is a silent no-op", async () => {
    const store = createMemoryPredictionStore();
    const resolution = makeResolution();
    await store.recordResolution(resolution);
    await expect(store.recordResolution({ ...resolution })).resolves.toBeUndefined();
  });

  it("rejects a different resolution for an already-recorded market key", async () => {
    const store = createMemoryPredictionStore();
    await store.recordResolution(makeResolution({ state: "won", returned: 75 }));
    await expect(
      store.recordResolution(makeResolution({ state: "lost", returned: 0 })),
    ).rejects.toThrow();
  });
});

describe("createMemoryPredictionStore() — seenFixtureIds", () => {
  it("starts empty", async () => {
    const store = createMemoryPredictionStore();
    expect(await store.loadSeenFixtureIds()).toEqual(new Set());
  });

  it("persists a marked fixture across reads", async () => {
    const store = createMemoryPredictionStore();
    await store.markFixtureSeen("fx-1");
    await store.markFixtureSeen("fx-2");
    const seen = await store.loadSeenFixtureIds();
    expect(seen.has("fx-1")).toBe(true);
    expect(seen.has("fx-2")).toBe(true);
    expect(seen.size).toBe(2);
  });

  it("marking the same fixture twice does not duplicate it", async () => {
    const store = createMemoryPredictionStore();
    await store.markFixtureSeen("fx-1");
    await store.markFixtureSeen("fx-1");
    expect((await store.loadSeenFixtureIds()).size).toBe(1);
  });

  it("returned sets are snapshots — mutating one does not affect the store", async () => {
    const store = createMemoryPredictionStore();
    await store.markFixtureSeen("fx-1");
    const snapshot = (await store.loadSeenFixtureIds()) as Set<string>;
    snapshot.add("fx-injected");
    expect((await store.loadSeenFixtureIds()).has("fx-injected")).toBe(false);
  });
});

describe("createMemoryPredictionStore() — checkpoint closures (SPEC §9)", () => {
  it("starts with no closed checkpoints for any fixture", async () => {
    const store = createMemoryPredictionStore();
    expect(await store.loadClosedCheckpoints("fx-1")).toEqual([]);
  });

  it("persists a closed checkpoint independent of whether a stake exists", async () => {
    const store = createMemoryPredictionStore();
    await store.recordCheckpointClosed("fx-1", 0);
    expect(await store.loadClosedCheckpoints("fx-1")).toEqual([0]);
  });

  it("survives a simulated refresh — a fresh read reflects prior closures without re-deriving them from stakes", async () => {
    const store = createMemoryPredictionStore();
    await store.recordCheckpointClosed("fx-1", 0);
    // No stake was ever recorded for fx-1 — closure must not depend on one.
    const closed = await store.loadClosedCheckpoints("fx-1");
    expect(closed).toEqual([0]);
  });

  it("recording the same checkpoint twice does not duplicate it (monotonic)", async () => {
    const store = createMemoryPredictionStore();
    await store.recordCheckpointClosed("fx-1", 0);
    await store.recordCheckpointClosed("fx-1", 0);
    expect(await store.loadClosedCheckpoints("fx-1")).toEqual([0]);
  });

  it("tracks closures independently per fixture", async () => {
    const store = createMemoryPredictionStore();
    await store.recordCheckpointClosed("fx-1", 0);
    await store.recordCheckpointClosed("fx-2", 1);
    expect(await store.loadClosedCheckpoints("fx-1")).toEqual([0]);
    expect(await store.loadClosedCheckpoints("fx-2")).toEqual([1]);
  });

  it("records both checkpoints for the same fixture", async () => {
    const store = createMemoryPredictionStore();
    await store.recordCheckpointClosed("fx-1", 0);
    await store.recordCheckpointClosed("fx-1", 1);
    expect(new Set(await store.loadClosedCheckpoints("fx-1"))).toEqual(new Set([0, 1]));
  });
});
