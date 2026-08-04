import { describe, expect, it } from "vitest";
import { SyntheticCrowdSimulator } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdSimulator";
import { DEFAULT_SYNTHETIC_CROWD_CONFIG } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdConfig";
import { liquidityForOutcomeCount } from "../../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type {
  SyntheticCrowdConfig,
  SyntheticCrowdSignalSnapshot,
} from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";
import { FakeSyntheticCrowdMarket } from "./support/FakeSyntheticCrowdMarket";

const OUTCOME_SEAT_IDS = ["seat-1", "SEAT0001", "seat-3"];

function config(overrides?: Partial<SyntheticCrowdConfig>): SyntheticCrowdConfig {
  return { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 10, seed: 7, ...overrides };
}

function newMarket(): FakeSyntheticCrowdMarket {
  return new FakeSyntheticCrowdMarket({
    outcomeSeatIds: OUTCOME_SEAT_IDS,
    b: liquidityForOutcomeCount(OUTCOME_SEAT_IDS.length),
    nowIso: "2026-07-26T12:00:00.000Z",
  });
}

const EARLY_SNAPSHOT: SyntheticCrowdSignalSnapshot = {
  optionSeatIds: OUTCOME_SEAT_IDS,
  favorabilityWeights: { "seat-1": 60, SEAT0001: 25, "seat-3": 15 },
};

const LATE_SNAPSHOT: SyntheticCrowdSignalSnapshot = {
  optionSeatIds: OUTCOME_SEAT_IDS,
  // The territory leader flips going into the second half of the match.
  favorabilityWeights: { "seat-1": 15, SEAT0001: 20, "seat-3": 65 },
};

/** Drives a simulator through a whole deterministic "match" of frames. */
async function runFullMatch(
  simulator: SyntheticCrowdSimulator,
  market: FakeSyntheticCrowdMarket,
  frameCount: number,
) {
  const results = [];
  for (let i = 0; i <= frameCount; i++) {
    const matchProgress = i / frameCount;
    const snapshot = matchProgress < 0.5 ? EARLY_SNAPSHOT : LATE_SNAPSHOT;
    results.push(
      await simulator.onReleasedFrame({
        snapshot,
        matchProgress,
        observedSequence: i,
      }),
    );
  }
  return results;
}

describe("SyntheticCrowdSimulator", () => {
  it("is a no-op when disabled (off by default)", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG }, // enabled: false, the shipped default
      target: market,
    });
    expect(DEFAULT_SYNTHETIC_CROWD_CONFIG.enabled).toBe(false);
    const result = await simulator.onReleasedFrame({
      snapshot: EARLY_SNAPSHOT,
      matchProgress: 0.1,
      observedSequence: 1,
    });
    expect(result.entries).toEqual([]);
    expect(market.trades).toEqual([]);
  });

  it("drives visible odds movement over the match", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config(), target: market });
    const before = market.readMarketState(null)!.prices.slice();
    await runFullMatch(simulator, market, 40);
    const after = market.readMarketState(null)!.prices;
    expect(after).not.toEqual(before);
    // The late-game signal flip (seat-3 becomes the territory leader) must
    // show up in the book: seat-3's price should have risen materially.
    const seat3Index = OUTCOME_SEAT_IDS.indexOf("seat-3");
    expect(after[seat3Index]).toBeGreaterThan(before[seat3Index] + 5);
    expect(market.trades.length).toBeGreaterThan(0);
  });

  it("is deterministic under a fixed seed: identical trade sequence, identical final prices", async () => {
    const marketA = newMarket();
    const simA = new SyntheticCrowdSimulator({ config: config({ seed: 2026 }), target: marketA });
    await runFullMatch(simA, marketA, 30);

    const marketB = newMarket();
    const simB = new SyntheticCrowdSimulator({ config: config({ seed: 2026 }), target: marketB });
    await runFullMatch(simB, marketB, 30);

    expect(simB.participantIds).toEqual(simA.participantIds);
    expect(marketB.trades).toEqual(marketA.trades);
    expect(marketB.readMarketState(null)!.prices).toEqual(marketA.readMarketState(null)!.prices);
  });

  it("a different seed produces a different trade sequence", async () => {
    const marketA = newMarket();
    const simA = new SyntheticCrowdSimulator({ config: config({ seed: 1 }), target: marketA });
    await runFullMatch(simA, marketA, 30);

    const marketB = newMarket();
    const simB = new SyntheticCrowdSimulator({ config: config({ seed: 2 }), target: marketB });
    await runFullMatch(simB, marketB, 30);

    expect(marketB.trades).not.toEqual(marketA.trades);
  });

  it("every synthetic participant id is in the sim_ namespace, disjoint from real guest_ ids", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config(), target: market });
    await runFullMatch(simulator, market, 20);
    expect(market.trades.length).toBeGreaterThan(0);
    for (const trade of market.trades) {
      expect(trade.participantId).toMatch(/^sim_[a-f0-9]{32}$/);
      expect(trade.participantKind).toBe("synthetic");
    }
  });

  it("real and synthetic stakes are exactly separable from the trade list alone", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config(), target: market });
    await runFullMatch(simulator, market, 20);

    // A real participant trades through the exact same order queue.
    const realParticipantId = `guest_${"7".repeat(32)}`;
    await market.createViewerSession({
      participantId: realParticipantId,
      idempotencyKey: "idem_real_session_001",
    });
    const {
      session: { id: sessionId },
    } = await market.createViewerSession({
      participantId: realParticipantId,
      idempotencyKey: "idem_real_session_001",
    });
    await market.submitMarketOrder({
      participantId: realParticipantId,
      participantKind: "real",
      sessionId,
      idempotencyKey: "idem_real_order_00001",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      seatId: "seat-1",
      side: "buy",
      sequence: 0,
      amount: 100,
      limitPrice: 100,
    });

    const syntheticTotal = market.trades
      .filter((t) => t.participantKind === "synthetic")
      .reduce((sum, t) => sum + (t.side === "buy" ? t.chips : 0), 0);
    const realTotal = market.trades
      .filter((t) => t.participantKind === "real")
      .reduce((sum, t) => sum + (t.side === "buy" ? t.chips : 0), 0);
    const grandTotal = market.trades.reduce(
      (sum, t) => sum + (t.side === "buy" ? t.chips : 0),
      0,
    );
    expect(realTotal).toBeGreaterThan(0);
    expect(realTotal).toBeLessThanOrEqual(100);
    expect(syntheticTotal + realTotal).toBe(grandTotal);
    expect(market.trades.filter((t) => t.participantId === realParticipantId)).toHaveLength(1);
  });

  it("keeps the ledger invariant exact with synthetic participants present, through trading and settlement", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config({ count: 14 }), target: market });
    await runFullMatch(simulator, market, 50);
    expect(market.ledgerTotal()).toBe(0);
    market.settle("seat-3");
    expect(market.ledgerTotal()).toBe(0);
  });

  it("holds positions across the whole continuous match and adjusts on the later signal instead of only ever buying", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config({ count: 16 }), target: market });
    await runFullMatch(simulator, market, 60);
    const sides = new Set(market.trades.map((t) => t.side));
    // A crowd that only ever buys produces a boring, monotonically
    // drifting book — the ported logic must still trim over-priced
    // holdings when the late-game signal flips.
    expect(sides.has("sell")).toBe(true);
    expect(sides.has("buy")).toBe(true);
  });

  it("cannot stake once the market is no longer open (settled mid-run)", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({ config: config({ count: 20, activityProbability: 1 }), target: market });
    // Run a few frames, then settle the market early (simulating the match
    // ending before every scheduled frame lands), then keep driving frames.
    for (let i = 0; i < 5; i++) {
      await simulator.onReleasedFrame({
        snapshot: EARLY_SNAPSHOT,
        matchProgress: i / 20,
        observedSequence: i,
      });
    }
    market.settle("seat-1");
    const tradesBeforePostSettle = market.trades.length;
    const postSettleResults = [];
    for (let i = 5; i < 12; i++) {
      postSettleResults.push(
        await simulator.onReleasedFrame({
          snapshot: EARLY_SNAPSHOT,
          matchProgress: i / 20,
          observedSequence: i,
        }),
      );
    }
    // No new trades landed after settlement...
    expect(market.trades.length).toBe(tradesBeforePostSettle);
    // ...and every bot that would have acted was gracefully skipped, never
    // threw past the simulator or corrupted the run.
    const allSkippedGracefully = postSettleResults.every((frame) =>
      frame.entries.every(
        (entry) => entry.kind === "skip" || market.trades.length === tradesBeforePostSettle,
      ),
    );
    expect(allSkippedGracefully).toBe(true);
    const marketNotOpenSkips = postSettleResults
      .flatMap((frame) => frame.entries)
      .filter((entry) => entry.kind === "skip" && entry.reason === "market_not_open");
    expect(marketNotOpenSkips.length).toBeGreaterThan(0);
  });

  it("replaying the identical (participantId, idempotencyKey) order never double-fills the market", async () => {
    const market = newMarket();
    const simulator = new SyntheticCrowdSimulator({
      config: config({ count: 5, activityProbability: 1 }),
      target: market,
    });
    await simulator.onReleasedFrame({
      snapshot: EARLY_SNAPSHOT,
      matchProgress: 0.1,
      observedSequence: 1,
    });
    const firstTrade = market.trades[0];
    expect(firstTrade).toBeDefined();
    const totalBefore = market.trades.length;
    // Simulate a caller retrying the exact same order after e.g. a network
    // hiccup: identical participantId + idempotencyKey must replay the
    // cached trade, never execute a second time.
    const { trade: replayed, idempotent } = await market.submitMarketOrder({
      participantId: firstTrade.participantId,
      participantKind: "synthetic",
      sessionId: `sess_${"1".repeat(32)}`,
      idempotencyKey: firstTrade.idempotencyKey,
      requesterBucketId: `ip_${"2".repeat(32)}`,
      seatId: firstTrade.seatId,
      side: firstTrade.side,
      sequence: 0,
      amount: 999_999, // deliberately different — must be ignored on replay
      limitPrice: 1,
    });
    expect(idempotent).toBe(true);
    expect(replayed).toEqual(firstTrade);
    expect(market.trades.length).toBe(totalBefore);
  });

  it("generates the identical idempotency-key sequence across two independent fresh runs with the same seed", async () => {
    const capturedKeys: string[][] = [[], []];
    for (const run of [0, 1] as const) {
      const market = newMarket();
      const capture = market.submitMarketOrder.bind(market);
      market.submitMarketOrder = (options) => {
        capturedKeys[run].push(`${options.participantId}:${options.idempotencyKey}`);
        return capture(options);
      };
      const simulator = new SyntheticCrowdSimulator({
        config: config({ count: 8, activityProbability: 1 }),
        target: market,
      });
      await simulator.onReleasedFrame({
        snapshot: EARLY_SNAPSHOT,
        matchProgress: 0.2,
        observedSequence: 1,
      });
    }
    expect(capturedKeys[0].length).toBeGreaterThan(0);
    expect(capturedKeys[1]).toEqual(capturedKeys[0]);
  });
});

describe("SyntheticCrowdSimulator — price convergence", () => {
  const FOUR_SEAT_IDS = ["seat-1", "seat-2", "seat-3", "seat-4"];

  function fourSeatMarket(): FakeSyntheticCrowdMarket {
    return new FakeSyntheticCrowdMarket({
      outcomeSeatIds: FOUR_SEAT_IDS,
      b: liquidityForOutcomeCount(FOUR_SEAT_IDS.length),
      nowIso: "2026-07-26T12:00:00.000Z",
    });
  }

  /**
   * Mirrors the reported match exactly: seat-3 ("Defensive Builder")
   * establishes a territory lead in the first ~12% of the match and holds
   * 30-38% of the board for the rest of it (oscillating like a real
   * contested board, never running away with it outright, matching "led
   * 30-38% of territory for most of a 14-minute match"). The other three
   * seats split the remainder.
   */
  function defensiveBuilderSnapshot(matchProgress: number): SyntheticCrowdSignalSnapshot {
    const rampProgress = Math.min(1, matchProgress / 0.12);
    const oscillation = matchProgress >= 0.12 ? 4 * Math.sin(matchProgress * 19) : 0;
    const leaderShare = Math.max(25, Math.min(38, 25 + rampProgress * 9 + oscillation));
    const others = (100 - leaderShare) / 3;
    return {
      optionSeatIds: FOUR_SEAT_IDS,
      favorabilityWeights: {
        "seat-1": others,
        "seat-2": others,
        "seat-3": leaderShare,
        "seat-4": others,
      },
    };
  }

  it("converges: a seat that leads 30-38% of territory for most of a long match is priced well above its 25 opening by settlement", async () => {
    const market = fourSeatMarket();
    const simulator = new SyntheticCrowdSimulator({
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 24, seed: 11 },
      target: market,
    });
    const leaderIndex = FOUR_SEAT_IDS.indexOf("seat-3");
    const openingPrices = market.readMarketState(null)!.prices.slice();
    expect(openingPrices[leaderIndex]).toBe(25);

    // 300 frames stands in for the continuous ~1s-poll trading window of a
    // long (14-minute-class) match.
    for (let i = 0; i <= 300; i++) {
      const matchProgress = i / 300;
      await simulator.onReleasedFrame({
        snapshot: defensiveBuilderSnapshot(matchProgress),
        matchProgress,
        observedSequence: i,
      });
    }

    const finalPrices = market.readMarketState(null)!.prices;
    // Threshold: 33. The opening is 25 (parity); a sustained ~30-38%
    // territory lead is real, durable evidence, not noise, so by
    // settlement the price should clear a bar that unambiguously reads
    // "the crowd's favorite," not just "slightly nudged." 33 tracks the
    // low end of the 30-38% signal band itself (measured final prices
    // land ~35-43 across seeds) and is comfortably outside anything the
    // liquidity tests above show a single order or short-lived noise
    // could produce — while still leaving real room below the LMSR's
    // ceiling for a sharp reader who acts on the raw leaderboard before
    // the (lagging, execution-friction-bound) crowd fully prices it in
    // (requirement 4: an edge stays available).
    expect(finalPrices[leaderIndex]).toBeGreaterThan(33);
    market.settle("seat-3");
    expect(market.trades.length).toBeGreaterThan(0);
  });

  it("stays uncertain: a genuinely close race with no sustained leader does not drift far from the 25 opening", async () => {
    const market = fourSeatMarket();
    const simulator = new SyntheticCrowdSimulator({
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 24, seed: 11 },
      target: market,
    });
    for (let i = 0; i <= 300; i++) {
      const matchProgress = i / 300;
      // Small, symmetric back-and-forth jitter around parity — nobody
      // ever separates from the pack the way seat-3 does above.
      const jitter = 2 * Math.sin(matchProgress * 23 + 1);
      await simulator.onReleasedFrame({
        snapshot: {
          optionSeatIds: FOUR_SEAT_IDS,
          favorabilityWeights: {
            "seat-1": 25 + jitter,
            "seat-2": 25 - jitter,
            "seat-3": 25 + jitter / 2,
            "seat-4": 25 - jitter / 2,
          },
        },
        matchProgress,
        observedSequence: i,
      });
    }
    const finalPrices = market.readMarketState(null)!.prices;
    for (const price of finalPrices) {
      expect(Math.abs(price - 25)).toBeLessThan(15);
    }
  });
});
