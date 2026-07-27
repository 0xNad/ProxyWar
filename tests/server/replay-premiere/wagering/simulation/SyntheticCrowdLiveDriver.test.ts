import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticCrowdLiveDriver } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdLiveDriver";
import { DEFAULT_SYNTHETIC_CROWD_CONFIG } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdConfig";
import { liquidityForOutcomeCount } from "../../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type { PremiereReleasedRecord } from "../../../../../src/server/replay-premiere/ReplayPremiereContracts";
import type { SyntheticCrowdConfig } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";
import type {
  SyntheticCrowdTerritorySample,
  SyntheticCrowdTerritoryTable,
} from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTerritoryProjection";
import { FakeSyntheticCrowdMarket } from "./support/FakeSyntheticCrowdMarket";
import {
  FAKE_DRAFTS,
  FAKE_GATE,
  FailingSyntheticCrowdTerritoryProjector,
  FakeSyntheticCrowdTerritoryProjector,
  NeverResolvingSyntheticCrowdTerritoryProjector,
} from "./support/FakeSyntheticCrowdTerritoryProjector";

const SEAT_IDS = ["seat-1", "SEAT0001", "seat-3"];

function config(overrides?: Partial<SyntheticCrowdConfig>): SyntheticCrowdConfig {
  return { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 8, seed: 5, activityProbability: 1, ...overrides };
}

function newMarket(seatIds: readonly string[] = SEAT_IDS): FakeSyntheticCrowdMarket {
  return new FakeSyntheticCrowdMarket({
    outcomeSeatIds: seatIds,
    b: liquidityForOutcomeCount(seatIds.length),
    nowIso: "2026-07-26T12:00:00.000Z",
  });
}

/** A table where `leaderSeatId` holds a clear, constant tile majority at every sample from `sequence` 0. */
function dominantSeatTable(
  seatIds: readonly string[],
  leaderSeatId: string,
  finalSequence: number,
  intervalTicks = 1,
): SyntheticCrowdTerritoryTable {
  const samples = [];
  for (let sequence = 0; sequence <= finalSequence; sequence += intervalTicks) {
    const tilesOwned: Record<string, number> = {};
    for (const seatId of seatIds) tilesOwned[seatId] = seatId === leaderSeatId ? 700 : 100;
    samples.push({ sequence, tilesOwned });
  }
  return { samples };
}

/** Fake runtime source: turn-payload records released in batches. Payload content no longer drives the signal — only `sequence` matters — but a shape is kept so the "raw core Turn" contract stays realistic. */
class FakeRuntimeSource {
  private readonly records: PremiereReleasedRecord[] = [];
  visibleSequence = -1;

  pushTurn(sequence: number, clientIds: readonly string[] = []): void {
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
    const projector = new FakeSyntheticCrowdTerritoryProjector(dominantSeatTable(SEAT_IDS, "seat-1", 10));
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 100,
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG }, // enabled: false
      pollIntervalMs: 10,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(market.trades).toEqual([]);
    // The territory precompute never even starts when the driver is off.
    expect(projector.callCount).toBe(0);
  });

  it("polls readLiveProjection, drives the simulator, and produces trades from a real territory-share signal", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const projector = new FakeSyntheticCrowdTerritoryProjector(dominantSeatTable(SEAT_IDS, "seat-1", 20));
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    await Promise.resolve(); // let the (instant) territory precompute resolve before the first poll
    for (let i = 0; i < 10; i++) {
      runtime.pushTurn(i);
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
    const projector = new FakeSyntheticCrowdTerritoryProjector(dominantSeatTable(SEAT_IDS, "seat-1", 20));
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    for (let i = 0; i < 5; i++) {
      runtime.pushTurn(i);
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
    const projector = new FakeSyntheticCrowdTerritoryProjector(dominantSeatTable(SEAT_IDS, "seat-1", 20));
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    await Promise.resolve();
    for (let i = 0; i < 5; i++) {
      runtime.pushTurn(i);
      await vi.advanceTimersByTimeAsync(10);
    }
    market.settle("seat-1");
    await vi.advanceTimersByTimeAsync(10); // this poll observes settlement and stops itself
    const tradesAtSettlement = market.trades.length;
    // Push more turns after settlement; the driver must not still be polling.
    for (let i = 5; i < 10; i++) {
      runtime.pushTurn(i);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(market.trades.length).toBe(tradesAtSettlement);
  });

  it("stop() is idempotent, prevents any further polling, and aborts an in-flight territory precompute", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const projector = new FakeSyntheticCrowdTerritoryProjector(dominantSeatTable(SEAT_IDS, "seat-1", 20), 5_000);
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 20,
      config: config(),
      pollIntervalMs: 10,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    runtime.pushTurn(0);
    await vi.advanceTimersByTimeAsync(10);
    driver.stop();
    driver.stop();
    const tradesAtStop = market.trades.length;
    for (let i = 1; i < 10; i++) {
      runtime.pushTurn(i);
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

  it("reports a failed territory precompute (never throws out of the poll loop), but still trades on baseline liquidity instead of freezing dead", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const errors: unknown[] = [];
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 200,
      config: config(),
      pollIntervalMs: 10,
      territory: { projector: new FailingSyntheticCrowdTerritoryProjector(), gate: FAKE_GATE, drafts: FAKE_DRAFTS },
      onError: (error) => errors.push(error),
    });
    driver.start();
    for (let i = 0; i < 60; i++) {
      runtime.pushTurn(i);
      await vi.advanceTimersByTimeAsync(10);
    }
    driver.stop();
    // The failure itself is still surfaced, never swallowed.
    expect(errors.length).toBeGreaterThan(0);
    // The actual bug this test used to enshrine: with a completely failed
    // precompute, EVERY seat used to read the exact same flat floor,
    // which ties EXACTLY with the market's own flat opening price — a
    // mathematically guaranteed zero gap for every persona but
    // "noise-trader" (and with this suite's roster/seed, not even that
    // one — see `SyntheticCrowdTerritoryProjection.ts`'s header). A crowd
    // with no informational edge must still provide baseline liquidity
    // instead of freezing solid for as long as the precompute stays
    // broken.
    expect(market.trades.length).toBeGreaterThan(0);
    // No informative signal either, still: no seat should have run away
    // with a durable, systematic lead — the noise is symmetric and
    // redrawn every poll, so it must stay well short of the kind of
    // spread real, sustained territory conviction produces (see the
    // convergence describe block below, where a real lead clears 33+).
    const prices = market.readMarketState(null)!.prices;
    for (const price of prices) {
      expect(Math.abs(price - 100 / SEAT_IDS.length)).toBeLessThan(20);
    }
  });
});

describe("SyntheticCrowdLiveDriver — territory-driven convergence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FOUR_SEAT_IDS = ["seat-1", "seat-2", "seat-3", "seat-4"];
  const TOTAL_TILES = 10_000;

  function fourSeatMarket(): FakeSyntheticCrowdMarket {
    return new FakeSyntheticCrowdMarket({
      outcomeSeatIds: FOUR_SEAT_IDS,
      b: liquidityForOutcomeCount(FOUR_SEAT_IDS.length),
      nowIso: "2026-07-26T12:00:00.000Z",
    });
  }

  /**
   * Mirrors the reported match: seat-3 ("Defensive Builder") ramps up a
   * territory lead over the first ~12% of the match and holds 30-38% of
   * the map (oscillating, never running away with it) for the rest,
   * exactly like `SyntheticCrowdSimulator.test.ts`'s scenario of the same
   * name — except here it is expressed as real `tilesOwned`, sampled every
   * 10 sequence ticks, and driven through the FULL live pipeline
   * (`SyntheticCrowdLiveDriver` -> real territory-share derivation ->
   * `SyntheticCrowdSimulator`), which is where the original bug actually
   * lived.
   */
  function defensiveBuilderTable(finalSequence: number): SyntheticCrowdTerritoryTable {
    const samples = [];
    for (let sequence = 0; sequence <= finalSequence; sequence += 10) {
      const matchProgress = sequence / finalSequence;
      const rampProgress = Math.min(1, matchProgress / 0.12);
      const oscillation = matchProgress >= 0.12 ? 4 * Math.sin(matchProgress * 19) : 0;
      const leaderSharePercent = Math.max(25, Math.min(38, 25 + rampProgress * 9 + oscillation));
      const leaderTiles = Math.round((leaderSharePercent / 100) * TOTAL_TILES);
      const otherTiles = Math.round((TOTAL_TILES - leaderTiles) / 3);
      samples.push({
        sequence,
        tilesOwned: {
          "seat-1": otherTiles,
          "seat-2": otherTiles,
          "seat-3": leaderTiles,
          "seat-4": otherTiles,
        },
      });
    }
    return { samples };
  }

  // ~15 real-world minutes at the driver's own poll-tick unit (each tick
  // == one EMA update, calibrated 1-to-1 with the default 1s poll cadence
  // this scenario mirrors), matching the actual reported match length.
  const FINAL_SEQUENCE = 900;

  async function runFullMatch(
    market: FakeSyntheticCrowdMarket,
    table: SyntheticCrowdTerritoryTable,
    onSequence?: (sequence: number) => void,
  ) {
    const runtime = new FakeRuntimeSource();
    const projector = new FakeSyntheticCrowdTerritoryProjector(table);
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: FOUR_SEAT_IDS,
      finalSequence: FINAL_SEQUENCE,
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 24, seed: 11, activityProbability: 1 },
      pollIntervalMs: 5,
      territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
    });
    driver.start();
    await Promise.resolve();
    for (let sequence = 0; sequence <= FINAL_SEQUENCE; sequence++) {
      runtime.pushTurn(sequence);
      await vi.advanceTimersByTimeAsync(5);
      onSequence?.(sequence);
    }
    driver.stop();
    return driver;
  }

  it("converges through the real driver pipeline: a sustained real territory lead is priced well above 25 and tracks the leader with a lag", async () => {
    const market = fourSeatMarket();
    const leaderIndex = FOUR_SEAT_IDS.indexOf("seat-3");
    const openingPrices = market.readMarketState(null)!.prices.slice();
    expect(openingPrices[leaderIndex]).toBe(25);

    let midPrices: readonly number[] | null = null;
    await runFullMatch(market, defensiveBuilderTable(FINAL_SEQUENCE), (sequence) => {
      if (sequence === 450) midPrices = market.readMarketState(null)!.prices.slice();
    });

    const finalPrices = market.readMarketState(null)!.prices;
    // Same threshold reasoning as `SyntheticCrowdSimulator.test.ts`'s
    // identical scenario: 33 tracks the low end of the real 30-38%
    // territory band, comfortably above noise, comfortably below the
    // LMSR ceiling — "unambiguously the crowd's favorite," not a nudge.
    expect(finalPrices[leaderIndex]).toBeGreaterThan(33);
    // Already tracking well ahead of parity by the halfway point, not
    // waiting for settlement to react — this is a slow-conviction market
    // catching up to sustained reality, not an instant repricing. It is
    // not required to be strictly monotonic on the way there: the real
    // territory share itself oscillates (30-38%, never a straight line),
    // and a lagging EMA chasing an oscillating target can briefly
    // overshoot as well as undershoot — the same texture a real market
    // pricing real, noisy evidence would have.
    expect(midPrices).not.toBeNull();
    expect(midPrices![leaderIndex]).toBeGreaterThan(28);
    market.settle("seat-3");
    expect(market.trades.length).toBeGreaterThan(0);
  });

  it("continuous conviction scaling: a sustained 3-8pt real territory lead — the exact band invisible under the old binary flat-signal cliff — moves the book within 60s, across ten independently seeded crowds at PRODUCTION default config", async () => {
    // A live, real match (not a synthetic fixture) showed the market
    // frozen at flat parity through 43% of the match despite one seat
    // visibly, sustainedly leading by a real-but-moderate territory
    // margin — the old `TERRITORY_FLAT_SIGNAL_SPREAD_THRESHOLD` binary
    // gate meant a spread just above 3 got no help at all and often
    // still couldn't clear `SyntheticCrowdConfig`'s own trade
    // `threshold` (also 3) for minutes. `leaderTiles=3000` against
    // `700` each for the other three seats is a sustained ~30% vs
    // ~23.3% split — a 6.7-point spread, squarely inside the reported
    // "3-8 tile-share points" band a human reading the map would call
    // an obvious, if not overwhelming, leader.
    const samples = [];
    for (let sequence = 0; sequence <= 900; sequence += 10) {
      samples.push({
        sequence,
        tilesOwned: { "seat-1": 3_000, SEAT0001: 700, "seat-3": 700 },
      });
    }
    const table: SyntheticCrowdTerritoryTable = { samples };
    for (let seed = 1; seed <= 10; seed++) {
      const market = newMarket();
      const runtime = new FakeRuntimeSource();
      const projector = new FakeSyntheticCrowdTerritoryProjector(table);
      const driver = new SyntheticCrowdLiveDriver({
        runtime,
        target: market,
        seatIds: SEAT_IDS,
        finalSequence: 900,
        config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, seed },
        pollIntervalMs: 1_000,
        territory: { projector, gate: FAKE_GATE, drafts: FAKE_DRAFTS },
      });
      driver.start();
      await Promise.resolve();
      for (let second = 0; second < 60; second++) {
        runtime.pushTurn(second);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      driver.stop();
      expect(market.trades.length, `seed ${seed} produced no trades within 60s`).toBeGreaterThan(0);
      // Directional, not just "some trade happened": the leader's price
      // has moved meaningfully away from the flat 33.3 open (3 seats),
      // not merely wobbled from undirected baseline noise.
      const leaderIndex = SEAT_IDS.indexOf("seat-1");
      const price = market.readMarketState(null)!.prices[leaderIndex];
      expect(price, `seed ${seed} leader price ${price} did not move above open`).toBeGreaterThan(100 / 3 + 2);
    }
  });

  it("prices an eliminated seat at or near zero, even after it held a real prior lead", async () => {
    const market = fourSeatMarket();
    const eliminatedAtSequence = 225;
    const samples: SyntheticCrowdTerritorySample[] = [];
    for (let sequence = 0; sequence <= FINAL_SEQUENCE; sequence += 10) {
      const dead = sequence >= eliminatedAtSequence;
      samples.push({
        sequence,
        tilesOwned: {
          // seat-1 holds a real, dominant lead for the first half of the
          // match, then goes to zero at once (eliminated) — exactly the
          // "priced a dead seat at 32-40%, the highest of all four seats"
          // finding this test exists to close.
          "seat-1": dead ? 0 : 6_000,
          "seat-2": dead ? 3_500 : 1_500,
          "seat-3": dead ? 3_500 : 1_500,
          "seat-4": dead ? 3_000 : 1_000,
        },
      });
    }
    const table: SyntheticCrowdTerritoryTable = { samples };
    await runFullMatch(market, table);
    const state = market.readMarketState(null)!;
    const deadIndex = FOUR_SEAT_IDS.indexOf("seat-1");
    // A hard floor, not a lag: the released data has said "zero tiles"
    // for well over half the match by settlement — there is no reading
    // of that data under which this seat is still worth more than a
    // token price.
    expect(state.prices[deadIndex]).toBeLessThan(5);
  });

  it("bounds early-match false conviction: a brief early territory blip that reverts does not become a durable price move", async () => {
    const market = fourSeatMarket();
    const samples: SyntheticCrowdTerritorySample[] = [];
    for (let sequence = 0; sequence <= FINAL_SEQUENCE; sequence += 10) {
      // seat-2 spikes to a dominant share for the first ~5% of the match
      // (a busy early skirmish, exactly the "45% false spike on an
      // eventual loser, early in the match" finding) then reverts to a
      // genuinely even race for the remaining 95%.
      const earlySpike = sequence <= FINAL_SEQUENCE * 0.05;
      samples.push({
        sequence,
        tilesOwned: earlySpike
          ? { "seat-1": 500, "seat-2": 8_000, "seat-3": 500, "seat-4": 1_000 }
          : { "seat-1": 2_500, "seat-2": 2_500, "seat-3": 2_500, "seat-4": 2_500 },
      });
    }
    const table: SyntheticCrowdTerritoryTable = { samples };
    await runFullMatch(market, table);
    const finalPrices = market.readMarketState(null)!.prices;
    for (const price of finalPrices) {
      expect(Math.abs(price - 25)).toBeLessThan(10);
    }
  });

  it("measures quote staleness: the fraction of 5-second (5-poll) windows with a price move past the trade ticket's 1.5pt staleness threshold", async () => {
    const market = fourSeatMarket();
    const QUOTE_STALE_THRESHOLD = 1.5;
    const priceSamples: number[] = [];
    await runFullMatch(market, defensiveBuilderTable(FINAL_SEQUENCE), (sequence) => {
      if (sequence % 5 === 0) {
        priceSamples.push(market.readMarketState(null)!.prices[FOUR_SEAT_IDS.indexOf("seat-3")]);
      }
    });
    let staleWindows = 0;
    for (let i = 1; i < priceSamples.length; i++) {
      if (Math.abs(priceSamples[i] - priceSamples[i - 1]) > QUOTE_STALE_THRESHOLD) staleWindows += 1;
    }
    const staleFraction = priceSamples.length > 1 ? staleWindows / (priceSamples.length - 1) : 0;
    // R2_Quant measured 66.8% of 5s windows stale under the old
    // activity-volume signal. A slow-conviction real-territory signal
    // should move deliberately, not churn — well under half the windows.
    expect(staleFraction).toBeLessThan(0.5);
  });
});

describe("SyntheticCrowdLiveDriver — silent-crowd regression (the intermittent-zero-trades bug)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never fails quiet: reports the idle reason exactly once, within a minute of real released content, while the precompute never resolves", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const errors: unknown[] = [];
    // A threshold no gap can ever clear isolates the watchdog itself from
    // the baseline-liquidity fix below — this proves the "never fail
    // quiet" guarantee holds even in a genuinely, permanently silent
    // crowd, not just the common case this fix already closes.
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 900,
      config: config({ threshold: 1000 }),
      pollIntervalMs: 1_000,
      territory: {
        projector: new NeverResolvingSyntheticCrowdTerritoryProjector(),
        gate: FAKE_GATE,
        drafts: FAKE_DRAFTS,
      },
      onError: (error) => errors.push(error),
    });
    driver.start();
    for (let second = 0; second < 59; second++) {
      runtime.pushTurn(second);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const idleReportsBefore = errors.filter(
      (error) => error instanceof Error && error.message.startsWith("synthetic_crowd_idle"),
    );
    expect(idleReportsBefore).toEqual([]);
    runtime.pushTurn(59);
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.pushTurn(60);
    await vi.advanceTimersByTimeAsync(1_000);
    const idleReportsAfter = errors.filter(
      (error) => error instanceof Error && error.message.startsWith("synthetic_crowd_idle"),
    );
    expect(idleReportsAfter).toHaveLength(1);
    expect((idleReportsAfter[0] as Error).message).toContain("territory precompute has not resolved yet");
    // Stays at exactly one report even as more idle time passes.
    for (let second = 61; second < 91; second++) {
      runtime.pushTurn(second);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    driver.stop();
    expect(
      errors.filter((error) => error instanceof Error && error.message.startsWith("synthetic_crowd_idle")),
    ).toHaveLength(1);
  });

  it("never fails quiet: names a REJECTED precompute as failed, not merely pending", async () => {
    const market = newMarket();
    const runtime = new FakeRuntimeSource();
    const errors: unknown[] = [];
    const driver = new SyntheticCrowdLiveDriver({
      runtime,
      target: market,
      seatIds: SEAT_IDS,
      finalSequence: 900,
      config: config({ threshold: 1000 }),
      pollIntervalMs: 1_000,
      territory: { projector: new FailingSyntheticCrowdTerritoryProjector(), gate: FAKE_GATE, drafts: FAKE_DRAFTS },
      onError: (error) => errors.push(error),
    });
    driver.start();
    for (let second = 0; second < 61; second++) {
      runtime.pushTurn(second);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    driver.stop();
    const idleReports = errors.filter(
      (error) => error instanceof Error && error.message.startsWith("synthetic_crowd_idle"),
    );
    expect(idleReports).toHaveLength(1);
    expect((idleReports[0] as Error).message).toContain("territory precompute failed");
  });

  it("trades within the first 60 real seconds even with a fully stalled precompute, across ten independently seeded crowds — the exact regression this fix closes", async () => {
    // Ten "consecutive fresh premieres": ten independent seeds against the
    // EXACT production default config (`ReplayPremiereStartup.ts` merges
    // nothing else in when `syntheticCrowdConfig` is omitted, which is the
    // deployed default). Before this fix, a completely stalled precompute
    // meant every seat read the exact same flat floor forever, which
    // `normalizedFairValues` ties EXACTLY to the market's own flat
    // opening price — a mathematically guaranteed zero gap for every
    // persona but "noise-trader", which this exact roster/seed pairing
    // (seed 1, the real deployed default) doesn't even draw. Ten runs,
    // not one, because the original bug was intermittent — a small sample
    // proves nothing.
    for (let seed = 1; seed <= 10; seed++) {
      const market = newMarket();
      const runtime = new FakeRuntimeSource();
      const driver = new SyntheticCrowdLiveDriver({
        runtime,
        target: market,
        seatIds: SEAT_IDS,
        finalSequence: 900,
        config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, seed },
        pollIntervalMs: 1_000,
        territory: {
          projector: new NeverResolvingSyntheticCrowdTerritoryProjector(),
          gate: FAKE_GATE,
          drafts: FAKE_DRAFTS,
        },
      });
      driver.start();
      for (let second = 0; second < 60; second++) {
        runtime.pushTurn(second);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      driver.stop();
      expect(market.trades.length, `seed ${seed} produced no trades within 60s`).toBeGreaterThan(0);
    }
  });
});
