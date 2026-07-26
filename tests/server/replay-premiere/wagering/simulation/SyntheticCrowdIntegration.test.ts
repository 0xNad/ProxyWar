/**
 * Integration test against the REAL `ReplayPremiereInteractions` class —
 * not the FakeSyntheticCrowdMarket double used elsewhere in this
 * directory. Proves `SyntheticCrowdSimulator` drives the actual
 * server-authoritative order queue a live premiere would use: no adapter
 * code, `ReplayPremiereInteractions` satisfies `SyntheticCrowdMarketTarget`
 * structurally (same method names/shapes real participants call).
 */
import { describe, expect, it } from "vitest";
import type { PremiereState } from "../../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereInteractions } from "../../../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { SyntheticCrowdSimulator } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdSimulator";
import { DEFAULT_SYNTHETIC_CROWD_CONFIG } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdConfig";
import type { SyntheticCrowdSignalSnapshot } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";

const premiereId = "prem_abcdefghijklmnop";
const guestReal = `guest_${"a".repeat(32)}`;

function harness(overrides?: { wageringEnabled?: boolean }) {
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  let premiereState: PremiereState = "playing";
  let randomValue = 1;
  const interactions = new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: [
      {
        seatId: "seat-1",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: "SEAT0001",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
      {
        seatId: "seat-3",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "gamma",
          declaredVersion: "1",
          manifestSha256: "5".repeat(64),
          contentSha256: "6".repeat(64),
        },
      },
    ],
    getPremiereState: () => premiereState,
    getReleasedContext: (sequence) =>
      sequence <= 100
        ? { releasedThroughSequence: 100, turn: sequence, eventContext: null }
        : null,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date(nowMs),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    wageringEnabled: overrides?.wageringEnabled ?? true,
    admitAnonymousWrite: () => undefined,
  });
  return {
    interactions,
    setPremiereState(state: PremiereState) {
      premiereState = state;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

const EARLY_SNAPSHOT: SyntheticCrowdSignalSnapshot = {
  optionSeatIds: ["seat-1", "SEAT0001", "seat-3"],
  favorabilityWeights: { "seat-1": 55, SEAT0001: 30, "seat-3": 15 },
};

const LATE_SNAPSHOT: SyntheticCrowdSignalSnapshot = {
  optionSeatIds: ["seat-1", "SEAT0001", "seat-3"],
  favorabilityWeights: { "seat-1": 15, SEAT0001: 25, "seat-3": 60 },
};

describe("SyntheticCrowdSimulator against the real ReplayPremiereInteractions", () => {
  it("drives real trades and visible odds movement through the actual submitMarketOrder/createViewerSession/readMarketState methods", async () => {
    const h = harness();
    const simulator = new SyntheticCrowdSimulator({
      config: {
        ...DEFAULT_SYNTHETIC_CROWD_CONFIG,
        enabled: true,
        count: 12,
        seed: 99,
      },
      // Structural match: ReplayPremiereInteractions has readMarketState /
      // createViewerSession / submitMarketOrder with the exact shapes
      // SyntheticCrowdMarketTarget requires — no bot-only adapter.
      target: h.interactions,
    });

    const before = h.interactions.readMarketState(null)!.prices.slice();
    for (let i = 0; i <= 40; i++) {
      const matchProgress = i / 40;
      await simulator.onReleasedFrame({
        snapshot: matchProgress < 0.5 ? EARLY_SNAPSHOT : LATE_SNAPSHOT,
        matchProgress,
        observedSequence: 35 + i,
      });
    }
    const after = h.interactions.readMarketState(null)!.prices;
    expect(after).not.toEqual(before);

    const snapshot = h.interactions.readState();
    expect(snapshot.trades.length).toBeGreaterThan(0);
    // Every trade landed through the real event-sourced snapshot's `trades`
    // collection, every one tagged synthetic, every one under the sim_
    // namespace — separable from real stakes without any side bookkeeping.
    for (const trade of snapshot.trades) {
      expect(trade.participantKind).toBe("synthetic");
      expect(trade.participantId).toMatch(/^sim_[a-f0-9]{32}$/);
    }

    // A real guest participant trades through the identical path.
    const session = await h.interactions.createViewerSession({
      participantId: guestReal,
      idempotencyKey: "idem_0000000000000001",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 35,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    await h.interactions.submitMarketOrder({
      participantId: guestReal,
      participantKind: "real",
      sessionId: session.id,
      idempotencyKey: "idem_0000000000000002",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      seatId: "seat-1",
      side: "buy",
      amount: 50,
      limitPrice: 100,
    });

    const finalSnapshot = h.interactions.readState();
    const realStake = finalSnapshot.trades
      .filter((t) => t.participantKind === "real")
      .reduce((sum, t) => sum + (t.side === "buy" ? t.chips : 0), 0);
    const syntheticStake = finalSnapshot.trades
      .filter((t) => t.participantKind === "synthetic")
      .reduce((sum, t) => sum + (t.side === "buy" ? t.chips : 0), 0);
    // Exact real-only total, recoverable purely from the trade list.
    expect(realStake).toBeGreaterThan(0);
    expect(realStake).toBeLessThanOrEqual(50);
    expect(syntheticStake).toBeGreaterThan(0);

    // The production ledger invariant (server-side, not a mirrored copy)
    // holds with synthetic participants mixed into real trading traffic.
    expect(finalSnapshot.market!.ledgerBalances).toBeDefined();
    const ledgerTotal = Object.values(finalSnapshot.market!.ledgerBalances).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(ledgerTotal).toBe(0);
  });

  it("stops staking once the premiere is no longer live, through the real market_not_live gate", async () => {
    const h = harness();
    const simulator = new SyntheticCrowdSimulator({
      config: {
        ...DEFAULT_SYNTHETIC_CROWD_CONFIG,
        enabled: true,
        count: 10,
        seed: 3,
        activityProbability: 1,
      },
      target: h.interactions,
    });
    await simulator.onReleasedFrame({
      snapshot: EARLY_SNAPSHOT,
      matchProgress: 0.1,
      observedSequence: 35,
    });
    const tradesBefore = h.interactions.readState().trades.length;
    expect(tradesBefore).toBeGreaterThan(0);

    h.setPremiereState("revealed"); // the premiere is no longer live/tradeable
    const frame = await simulator.onReleasedFrame({
      snapshot: EARLY_SNAPSHOT,
      matchProgress: 0.9,
      observedSequence: 40,
    });
    expect(h.interactions.readState().trades.length).toBe(tradesBefore);
    expect(
      frame.entries.some(
        (entry) => entry.kind === "skip" && entry.reason === "order_rejected",
      ),
    ).toBe(true);
  });

  it("stays off when wageringEnabled is false — byte-identical to no simulator running at all", async () => {
    const h = harness({ wageringEnabled: false });
    const simulator = new SyntheticCrowdSimulator({
      config: { ...DEFAULT_SYNTHETIC_CROWD_CONFIG, enabled: true, count: 10, seed: 1 },
      target: h.interactions,
    });
    await simulator.onReleasedFrame({
      snapshot: EARLY_SNAPSHOT,
      matchProgress: 0.1,
      observedSequence: 35,
    });
    expect(h.interactions.readState().trades).toEqual([]);
    expect(h.interactions.readState().market).toBeNull();
  });
});
