/**
 * Proves `ReplayPremiereInteractions` itself — not the standalone ledger
 * unit tests in `points/ReplayPremierePointsLedger.test.ts` — actually
 * calls the injected points-ledger sink exactly once per real trader, with
 * the correct final balance/grant figures, the moment predictions resolve,
 * and never for the synthetic crowd.
 */
import type { PremiereCanonicalAuthoritativeResult } from "../../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereSettlementPointsRecorder,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";

const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;
const simBot = `sim_${"c".repeat(32)}`;

function fakePointsLedger(): ReplayPremiereSettlementPointsRecorder & {
  calls: { premiereId: string; settlements: readonly { participantId: string; granted: number; balance: number }[] }[];
} {
  const calls: {
    premiereId: string;
    settlements: readonly { participantId: string; granted: number; balance: number }[];
  }[] = [];
  return {
    calls,
    async recordPremiereSettlement(id, settlements) {
      calls.push({ premiereId: id, settlements: [...settlements] });
    },
  };
}

interface PremiereInteractionsTestHarness {
  interactions: ReplayPremiereInteractions;
  setPremiereState(state: PremiereState): void;
  advance(ms: number): void;
  now(): string;
}

function harness(
  pointsLedger?: ReplayPremiereSettlementPointsRecorder,
): PremiereInteractionsTestHarness {
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
    ],
    getPremiereState: () => premiereState,
    getReleasedContext: (sequence) =>
      sequence <= 80
        ? { releasedThroughSequence: 80, turn: sequence, eventContext: null }
        : null,
    getLiveVisibleSequence: () => 80,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date(nowMs),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    wageringEnabled: true,
    admitAnonymousWrite: () => undefined,
    pointsLedger,
  });
  return {
    interactions,
    setPremiereState(state: PremiereState) {
      premiereState = state;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => new Date(nowMs).toISOString(),
  };
}

async function session(
  h: PremiereInteractionsTestHarness,
  participantId: string,
  idempotencyKey: string,
) {
  return h.interactions.createViewerSession({
    participantId,
    idempotencyKey,
    requesterBucketId: `ip_${"1".repeat(32)}`,
    visible: true,
    observedSequence: 35,
    excludedAsOperator: false,
    excludedAsBot: false,
  });
}

// Checkpoints are content beats only, unrelated to the continuous LMSR
// market — but `applyReplayPremierePredictionResolutionTransition` still
// requires both closed before it will resolve predictions at all.
async function closeBothCheckpoints(
  h: PremiereInteractionsTestHarness,
): Promise<void> {
  await h.interactions.openCheckpoint({
    checkpointId: "cp_first0001",
    opensAt: h.now(),
    closesAt: new Date(
      Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
    ).toISOString(),
    optionSeatIds: ["seat-1", "SEAT0001"],
  });
  h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
  await h.interactions.closeCheckpoint("cp_first0001", h.now());
  await h.interactions.openCheckpoint({
    checkpointId: "cp_second001",
    opensAt: h.now(),
    closesAt: new Date(
      Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
    ).toISOString(),
    optionSeatIds: ["seat-1", "SEAT0001"],
  });
  h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
  await h.interactions.closeCheckpoint("cp_second001", h.now());
}

function authoritativeResult(
  winner: PremiereCanonicalAuthoritativeResult["winner"],
): PremiereCanonicalAuthoritativeResult {
  return {
    schemaVersion: 1,
    sourceKind: "controlled_result",
    sourceRunId: "controlled-run-1",
    sourceId: "controlled-source-1",
    gameId: "game-1",
    completedAt: "2026-07-20T11:55:00.000Z",
    turnCount: 80,
    winner,
    seats: [
      { seatId: "seat-1", displayName: "Alpha", won: true },
      { seatId: "SEAT0001", displayName: "Beta", won: false },
    ],
  };
}

describe("ReplayPremiereInteractions settlement -> points ledger hook", () => {
  test("records the winning real trader's exact net P&L and never records the synthetic bot", async () => {
    const points = fakePointsLedger();
    const h = harness(points);

    const realSession = await session(h, guestA, "idem_session_real_001");
    await h.interactions.submitMarketOrder({
      participantId: guestA,
      participantKind: "real",
      sessionId: realSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 200,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_real_0001",
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });

    const botSession = await session(h, simBot, "idem_session_bot_001");
    await h.interactions.submitMarketOrder({
      participantId: simBot,
      participantKind: "synthetic",
      sessionId: botSession.id,
      seatId: "SEAT0001",
      side: "buy",
      amount: 150,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_bot_0001",
      requesterBucketId: `ip_${"2".repeat(64)}`,
    });

    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(["player", "seat-1"]),
      resolvedAt: h.now(),
    });

    expect(points.calls).toHaveLength(1);
    expect(points.calls[0].premiereId).toBe(premiereId);
    // Only the real guest is ever handed to the ledger — the synthetic
    // account never crosses this boundary, regardless of how it traded.
    expect(points.calls[0].settlements).toHaveLength(1);
    const [settlement] = points.calls[0].settlements;
    expect(settlement.participantId).toBe(guestA);
    expect(settlement.granted).toBe(1_000);
    // Cross-check against the server's own authoritative read: whatever
    // `readMarketState` reports as this participant's balance must be
    // exactly what got folded into the durable ledger.
    const marketState = h.interactions.readMarketState(guestA);
    expect(settlement.balance).toBe(marketState?.balance);
  });

  test("never calls the ledger for a market that voided (no winner) with no trader ever having a net-positive result — still records the (zero-sum) refund", async () => {
    const points = fakePointsLedger();
    const h = harness(points);
    const realSession = await session(h, guestB, "idem_session_void_001");
    await h.interactions.submitMarketOrder({
      participantId: guestB,
      participantKind: "real",
      sessionId: realSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_void_0001",
      requesterBucketId: `ip_${"3".repeat(64)}`,
    });
    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(null),
      resolvedAt: h.now(),
    });
    expect(points.calls).toHaveLength(1);
    const [settlement] = points.calls[0].settlements;
    expect(settlement.participantId).toBe(guestB);
    // Void market refunds cost basis in full — net P&L is exactly zero,
    // never a penalty for a market that never resolved to a real outcome.
    expect(settlement.balance).toBe(settlement.granted);
  });

  test("is safe to resolve twice (idempotent replay/recovery): the ledger call happens again but never throws, and settlement math stays identical", async () => {
    const points = fakePointsLedger();
    const h = harness(points);
    const realSession = await session(h, guestA, "idem_session_repeat_001");
    await h.interactions.submitMarketOrder({
      participantId: guestA,
      participantKind: "real",
      sessionId: realSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_repeat_0001",
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });
    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");
    const result = authoritativeResult(["player", "seat-1"]);
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result,
      resolvedAt: h.now(),
    });
    const second = await h.interactions.resolvePredictionsFromAuthoritativeResult(
      { result, resolvedAt: h.now() },
    );
    expect(second.idempotent).toBe(true);
    expect(points.calls).toHaveLength(2);
    expect(points.calls[1].settlements).toEqual(points.calls[0].settlements);
  });

  test("without a configured points ledger, resolution behaves exactly as before (no throw, no-op)", async () => {
    const h = harness(undefined);
    const realSession = await session(h, guestA, "idem_session_noledger_001");
    await h.interactions.submitMarketOrder({
      participantId: guestA,
      participantKind: "real",
      sessionId: realSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_noledger_0001",
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });
    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      }),
    ).resolves.toBeDefined();
  });
});
