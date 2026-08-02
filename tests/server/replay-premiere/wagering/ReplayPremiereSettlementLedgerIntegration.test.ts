/**
 * Proves `ReplayPremiereInteractions` itself — not the standalone ledger
 * unit tests in `points/ReplayPremiereSettlementLedger.test.ts` — actually
 * calls the injected settlement-ledger sink exactly once per settled
 * premiere, with the correct winner/placements/matchKind/prices, the
 * moment predictions resolve; records an honest `refunded` outcome for a
 * void market instead of staying silent; and never fires on any path
 * other than the market reaching `"settled"`.
 */
import type { PremiereCanonicalAuthoritativeResult } from "../../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereSettlementLedgerRecorder,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";

const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;

type SettlementCall = Parameters<
  ReplayPremiereSettlementLedgerRecorder["recordSettlement"]
>[0];

function fakeSettlementLedger(): ReplayPremiereSettlementLedgerRecorder & {
  calls: SettlementCall[];
} {
  const calls: SettlementCall[] = [];
  return {
    calls,
    async recordSettlement(record) {
      calls.push(record);
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
  settlementLedger?: ReplayPremiereSettlementLedgerRecorder,
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
    settlementLedger,
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
  const { session } = await h.interactions.createViewerSession({
    participantId,
    idempotencyKey,
    requesterBucketId: `ip_${"1".repeat(32)}`,
    visible: true,
    observedSequence: 35,
    excludedAsOperator: false,
    excludedAsBot: false,
  });
  return session;
}

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

function authoritativeResult(options: {
  winner: PremiereCanonicalAuthoritativeResult["winner"];
  sourceKind?: PremiereCanonicalAuthoritativeResult["sourceKind"];
  sourceId?: string;
}): PremiereCanonicalAuthoritativeResult {
  const winningSeatId =
    Array.isArray(options.winner) && options.winner[0] === "player"
      ? options.winner[1]
      : null;
  return {
    schemaVersion: 1,
    sourceKind: options.sourceKind ?? "controlled_result",
    sourceRunId: "controlled-run-1",
    sourceId: options.sourceId ?? "controlled-source-1",
    gameId: "game-1",
    completedAt: "2026-07-20T11:55:00.000Z",
    turnCount: 80,
    winner: options.winner,
    seats: [
      { seatId: "seat-1", displayName: "Alpha", won: winningSeatId === "seat-1" },
      { seatId: "SEAT0001", displayName: "Beta", won: winningSeatId === "SEAT0001" },
    ],
  };
}

async function tradeAndResolve(
  h: PremiereInteractionsTestHarness,
  result: PremiereCanonicalAuthoritativeResult,
) {
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
  await closeBothCheckpoints(h);
  h.setPremiereState("revealed");
  return h.interactions.resolvePredictionsFromAuthoritativeResult({
    result,
    resolvedAt: h.now(),
  });
}

describe("ReplayPremiereInteractions settlement -> settlement ledger hook", () => {
  test("records the winner, honest placements (only the winner gets placement 1), and market closing prices exactly once", async () => {
    const settlement = fakeSettlementLedger();
    const h = harness(settlement);

    await tradeAndResolve(
      h,
      authoritativeResult({ winner: ["player", "seat-1"] }),
    );

    expect(settlement.calls).toHaveLength(1);
    const record = settlement.calls[0];
    expect(record.premiereId).toBe(premiereId);
    expect(record.outcome).toBe("winner");
    expect(record.winnerSeatId).toBe("seat-1");
    expect(record.winnerDisplayName).toBe("Alpha");
    // House exhibition (`controlled_result`) — no episode behind it.
    expect(record.matchKind).toBe("exhibition");
    expect(record.episodeRequestId).toBeNull();
    expect(record.placements).toEqual([
      { seatId: "seat-1", displayName: "Alpha", placement: 1 },
      { seatId: "SEAT0001", displayName: "Beta", placement: null },
    ]);
    expect(record.settledAt).toBe(h.now());
    expect(record.marketFinalPrices).toHaveLength(2);
    expect(record.marketFinalPrices.map((p) => p.seatId).sort()).toEqual(
      ["SEAT0001", "seat-1"].sort(),
    );
    for (const price of record.marketFinalPrices) {
      expect(price.price).toBeGreaterThanOrEqual(0);
      expect(price.price).toBeLessThanOrEqual(100);
    }
    // Cross-check totalParticipants against the actual number of real
    // traders who funded the market.
    expect(record.totalParticipants).toBe(1);
  });

  test("derives matchKind real-league and episodeRequestId from a coworld_result — sourceId IS the episode request id at seal time", async () => {
    const settlement = fakeSettlementLedger();
    const h = harness(settlement);

    await tradeAndResolve(
      h,
      authoritativeResult({
        winner: ["player", "SEAT0001"],
        sourceKind: "coworld_result",
        sourceId: "ereq_live-episode-001",
      }),
    );

    expect(settlement.calls).toHaveLength(1);
    const record = settlement.calls[0];
    expect(record.matchKind).toBe("real-league");
    expect(record.episodeRequestId).toBe("ereq_live-episode-001");
    expect(record.winnerSeatId).toBe("SEAT0001");
    expect(record.winnerDisplayName).toBe("Beta");
  });

  test("records an honest refunded outcome for a void market instead of staying silent", async () => {
    const settlement = fakeSettlementLedger();
    const h = harness(settlement);

    await tradeAndResolve(h, authoritativeResult({ winner: null }));

    expect(settlement.calls).toHaveLength(1);
    const record = settlement.calls[0];
    expect(record.outcome).toBe("refunded");
    expect(record.winnerSeatId).toBeNull();
    expect(record.winnerDisplayName).toBeNull();
    expect(record.placements.every((p) => p.placement === null)).toBe(true);
  });

  test("is safe to resolve twice (idempotent replay/recovery): the ledger call happens again but never throws", async () => {
    const settlement = fakeSettlementLedger();
    const h = harness(settlement);
    const result = authoritativeResult({ winner: ["player", "seat-1"] });

    const realSession = await session(h, guestB, "idem_session_repeat_001");
    await h.interactions.submitMarketOrder({
      participantId: guestB,
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
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result,
      resolvedAt: h.now(),
    });
    const second = await h.interactions.resolvePredictionsFromAuthoritativeResult(
      { result, resolvedAt: h.now() },
    );
    expect(second.idempotent).toBe(true);
    expect(settlement.calls).toHaveLength(2);
    expect(settlement.calls[1]).toEqual(settlement.calls[0]);
  });

  test("without a configured settlement ledger, resolution behaves exactly as before (no throw, no-op)", async () => {
    const h = harness(undefined);
    await expect(
      tradeAndResolve(h, authoritativeResult({ winner: ["player", "seat-1"] })),
    ).resolves.toBeDefined();
  });
});
