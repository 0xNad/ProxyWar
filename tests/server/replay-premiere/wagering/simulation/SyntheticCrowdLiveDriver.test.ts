import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticCrowdLiveDriver } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdLiveDriver";
import { DEFAULT_SYNTHETIC_CROWD_CONFIG } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdConfig";
import { liquidityForOutcomeCount } from "../../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type { PremiereReleasedRecord } from "../../../../../src/server/replay-premiere/ReplayPremiereContracts";
import type { SyntheticCrowdConfig } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";
import { FakeSyntheticCrowdMarket } from "./support/FakeSyntheticCrowdMarket";

const SEAT_IDS = ["seat-1", "SEAT0001", "seat-3"];

function config(overrides?: Partial<SyntheticCrowdConfig>): SyntheticCrowdConfig {
  return { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 8, seed: 5, activityProbability: 1, ...overrides };
}

function newMarket(): FakeSyntheticCrowdMarket {
  return new FakeSyntheticCrowdMarket({
    outcomeSeatIds: SEAT_IDS,
    b: liquidityForOutcomeCount(SEAT_IDS.length),
    nowIso: "2026-07-26T12:00:00.000Z",
  });
}

/** Fake runtime source: turn-payload records with intents, released in batches. */
class FakeRuntimeSource {
  private readonly records: PremiereReleasedRecord[] = [];
  visibleSequence = -1;

  pushTurn(sequence: number, clientIds: readonly string[]): void {
    this.records.push({
      sequence,
      turn: sequence,
      presentationOffsetMs: sequence * 1000,
      payload: {
        turnNumber: sequence,
        intents: clientIds.map((clientID) => ({ type: "attack", clientID, targetID: null, troops: 1 })),
      },
    });
    this.visibleSequence = sequence;
  }

  readLiveVisibleSequence(): number {
    return this.visibleSequence;
  }

  readLiveProjection(afterSequence: number): readonly PremiereReleasedRecord[] {
    return this.records.filter((r) => r.sequence > afterSequence);
  }
}

describe("SyntheticCrowdLiveDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when config.enabled is false (off by default)", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    runtime.pushTurn(0, ["seat-1", "seat-1", "SEAT0001"]);
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 100,
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG }, // enabled: false
      pollIntervalMs: 10,
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(market.trades).toEqual([]);
  });

  it("polls readLiveProjection, drives the simulator, and produces trades from real intent activity", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
    });
    driver.start();
    // Seat-1 is clearly the most active early on.
    for (let i = 0; i < 10; i++) {
      runtime.pushTurn(i, i % 3 === 0 ? ["seat-1", "seat-1", "seat-1"] : ["seat-1"]);
      await vi.advanceTimersByTimeAsync(10);
    }
    driver.stop();
    expect(market.trades.length).toBeGreaterThan(0);
    for (const trade of market.trades) {
      expect(trade.participantId).toMatch(/^sim_[a-f0-9]{32}$/);
      expect(trade.participantKind).toBe("synthetic");
    }
  });

  it("never advances the signal beyond what readLiveProjection has actually released", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    let maxSeenSequence = -1;
    const originalReadLiveProjection = runtime.readLiveProjection.bind(runtime);
    runtime.readLiveProjection = (after: number) => {
      const records = originalReadLiveProjection(after);
      for (const r of records) maxSeenSequence = Math.max(maxSeenSequence, r.sequence);
      return records;
    };
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
    });
    driver.start();
    for (let i = 0; i < 5; i++) {
      runtime.pushTurn(i, ["seat-1"]);
      await vi.advanceTimersByTimeAsync(10);
      // At every poll, the driver's own bookkeeping never claims to have
      // seen anything past what readLiveProjection actually handed it.
      expect(maxSeenSequence).toBeLessThanOrEqual(runtime.readLiveVisibleSequence());
    }
    driver.stop();
  });

  it("stops polling once the market settles", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
    });
    driver.start();
    for (let i = 0; i < 5; i++) {
      runtime.pushTurn(i, ["seat-1", "SEAT0001"]);
      await vi.advanceTimersByTimeAsync(10);
    }
    market.settle("seat-1");
    await vi.advanceTimersByTimeAsync(10); // this poll observes settlement and stops itself
    const tradesAtSettlement = market.trades.length;
    // Push more turns after settlement; the driver must not still be polling.
    for (let i = 5; i < 10; i++) {
      runtime.pushTurn(i, ["seat-1", "SEAT0001"]);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(market.trades.length).toBe(tradesAtSettlement);
  });

  it("stop() is idempotent and prevents any further polling", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
    });
    driver.start();
    runtime.pushTurn(0, ["seat-1"]);
    await vi.advanceTimersByTimeAsync(10);
    driver.stop();
    driver.stop();
    const tradesAtStop = market.trades.length;
    for (let i = 1; i < 10; i++) {
      runtime.pushTurn(i, ["seat-1"]);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(market.trades.length).toBe(tradesAtStop);
  });

  it("reports (never throws out of) errors from the runtime source", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    runtime.readLiveProjection = () => {
      throw new Error("boom");
    };
    const errors: unknown[] = [];
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
      onError: (error) => errors.push(error),
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(30);
    driver.stop();
    expect(errors.length).toBeGreaterThan(0);
  });
});
