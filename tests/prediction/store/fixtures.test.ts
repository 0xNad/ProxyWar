/**
 * Unit tests for src/prediction/store/fixtures.ts — SPEC §9: the fixture
 * loader seam, plus the type- and runtime-level guard that keeps view code
 * from reading a fixture's outcome or post-checkpoint replay frames before
 * the relevant checkpoint has closed.
 */
import { describe, expect, it } from "vitest";

import {
  CheckpointGate,
  createBundledFixtureSource,
  readFixtureOutcome,
  toFixtureBriefing,
  visibleFrames,
} from "../../../src/prediction/store/fixtures";
import type { Checkpoint, Fixture, ReplayFrame, SeatSnapshot } from "../../../src/prediction/types";

function seat(seatId: string): SeatSnapshot {
  return { seatId, name: seatId, shareBp: 2_500, alive: true };
}

function checkpoint(index: 0 | 1, turn: number, resolutionTurn: number): Checkpoint {
  return { index, turn, resolutionTurn, seats: [seat("a")] };
}

function frame(turn: number): ReplayFrame {
  return { turn, shareBp: [2_500], alive: [true] };
}

function makeFixture(id: string, withReplay = false): Fixture {
  return {
    id,
    seed: 1,
    map: "testmap",
    mapSize: "Compact",
    nationCount: 4,
    checkpoints: [checkpoint(0, 10, 50), checkpoint(1, 30, 80)],
    outcome: {
      winnerSeatId: "a",
      eliminationOrder: [],
      shareAtResolution: [{ a: 3_000 }, { a: 4_000 }],
      finalTurn: 100,
    },
    ...(withReplay
      ? {
          replay: {
            frames: [
              frame(0),
              frame(5),
              frame(10), // checkpoint 0's turn
              frame(20),
              frame(30), // checkpoint 1's turn
              frame(40),
              frame(100), // final turn
            ],
          },
        }
      : {}),
  };
}

describe("createBundledFixtureSource()", () => {
  it("indexes injected fixture modules by their own id field, not the file path", async () => {
    const fixture = makeFixture("fx-abc");
    const source = createBundledFixtureSource({
      "../data/fixtures/some-arbitrary-filename.json": { default: fixture },
    });
    expect(await source.listFixtureIds()).toEqual(["fx-abc"]);
    expect(await source.loadFixture("fx-abc")).toEqual(fixture);
  });

  it("rejects an unknown fixture id", async () => {
    const source = createBundledFixtureSource({});
    await expect(source.loadFixture("nope")).rejects.toThrow();
  });

  it("indexes multiple fixtures", async () => {
    const source = createBundledFixtureSource({
      a: { default: makeFixture("fx-1") },
      b: { default: makeFixture("fx-2") },
    });
    expect(new Set(await source.listFixtureIds())).toEqual(new Set(["fx-1", "fx-2"]));
  });
});

describe("toFixtureBriefing()", () => {
  it("strips the outcome field entirely", () => {
    const fixture = makeFixture("fx-1");
    const briefing = toFixtureBriefing(fixture);
    expect(briefing).not.toHaveProperty("outcome");
    expect(briefing.id).toBe("fx-1");
    expect(briefing.checkpoints).toEqual(fixture.checkpoints);
  });

  it("strips the replay field entirely — no field on the briefing exposes the outcome or tail frames", () => {
    const fixture = makeFixture("fx-1", true);
    const briefing = toFixtureBriefing(fixture);
    expect(briefing).not.toHaveProperty("outcome");
    expect(briefing).not.toHaveProperty("replay");
    expect(Object.keys(briefing).sort()).toEqual(
      ["checkpoints", "id", "map", "mapSize", "nationCount", "seed"].sort(),
    );
  });
});

describe("CheckpointGate / readFixtureOutcome()", () => {
  it("starts with neither checkpoint closed", () => {
    const gate = new CheckpointGate();
    expect(gate.isCheckpointClosed(0)).toBe(false);
    expect(gate.isCheckpointClosed(1)).toBe(false);
    expect(gate.isFullyRevealed).toBe(false);
  });

  it("refuses to reveal the outcome until both checkpoints have closed", () => {
    const fixture = makeFixture("fx-1");
    const gate = new CheckpointGate();
    expect(() => readFixtureOutcome(fixture, gate)).toThrow();

    gate.closeCheckpoint(0);
    expect(gate.isCheckpointClosed(0)).toBe(true);
    expect(gate.isFullyRevealed).toBe(false);
    expect(() => readFixtureOutcome(fixture, gate)).toThrow();
  });

  it("reveals the outcome once both checkpoints have closed", () => {
    const fixture = makeFixture("fx-1");
    const gate = new CheckpointGate();
    gate.closeCheckpoint(0);
    gate.closeCheckpoint(1);
    expect(gate.isFullyRevealed).toBe(true);
    expect(readFixtureOutcome(fixture, gate)).toEqual(fixture.outcome);
  });

  it("closing checkpoints out of order still fully reveals", () => {
    const fixture = makeFixture("fx-1");
    const gate = new CheckpointGate();
    gate.closeCheckpoint(1);
    gate.closeCheckpoint(0);
    expect(readFixtureOutcome(fixture, gate)).toEqual(fixture.outcome);
  });

  it("each CheckpointGate instance tracks its own fixture-session independently", () => {
    const gateA = new CheckpointGate();
    const gateB = new CheckpointGate();
    gateA.closeCheckpoint(0);
    gateA.closeCheckpoint(1);
    expect(gateA.isFullyRevealed).toBe(true);
    expect(gateB.isFullyRevealed).toBe(false);
  });

  it("hydrates closed checkpoints from a persisted record via the constructor", () => {
    const gate = new CheckpointGate([0]);
    expect(gate.isCheckpointClosed(0)).toBe(true);
    expect(gate.isCheckpointClosed(1)).toBe(false);

    const fullyHydrated = new CheckpointGate([0, 1]);
    expect(fullyHydrated.isFullyRevealed).toBe(true);
  });
});

describe("visibleFrames() — gate-clipped replay access, SPEC §9", () => {
  it("before checkpoint 0 closes, exposes only frames up to checkpoint 0's turn", () => {
    const fixture = makeFixture("fx-1", true);
    const gate = new CheckpointGate();
    const frames = visibleFrames(fixture, gate);
    expect(frames.map((f) => f.turn)).toEqual([0, 5, 10]);
    // Not one frame past checkpoint 0's turn (10) is reachable — proves the
    // pre-close view cannot see later state, including the final frame.
    expect(frames.every((f) => f.turn <= fixture.checkpoints[0].turn)).toBe(true);
  });

  it("after checkpoint 0 closes but before checkpoint 1, exposes frames up to checkpoint 1's turn", () => {
    const fixture = makeFixture("fx-1", true);
    const gate = new CheckpointGate();
    gate.closeCheckpoint(0);
    const frames = visibleFrames(fixture, gate);
    expect(frames.map((f) => f.turn)).toEqual([0, 5, 10, 20, 30]);
    expect(frames.some((f) => f.turn > fixture.checkpoints[1].turn)).toBe(false);
  });

  it("once both checkpoints have closed, exposes every frame including the tail", () => {
    const fixture = makeFixture("fx-1", true);
    const gate = new CheckpointGate([0, 1]);
    const frames = visibleFrames(fixture, gate);
    expect(frames.map((f) => f.turn)).toEqual([0, 5, 10, 20, 30, 40, 100]);
  });

  it("closing checkpoint 1 without checkpoint 0 does not leak past checkpoint 0's turn (defensive default)", () => {
    const fixture = makeFixture("fx-1", true);
    const gate = new CheckpointGate();
    gate.closeCheckpoint(1); // out-of-order, should never happen via the real UI flow
    const frames = visibleFrames(fixture, gate);
    expect(frames.map((f) => f.turn)).toEqual([0, 5, 10]);
  });

  it("returns an empty array for a fixture with no replay data", () => {
    const fixture = makeFixture("fx-1", false);
    expect(visibleFrames(fixture, new CheckpointGate([0, 1]))).toEqual([]);
  });
});
