/**
 * Proves `ReplayPremiereInteractions` itself — not the standalone ledger
 * unit tests in `points/ReplayPremiereSettlementLedger.test.ts` — actually
 * calls the injected settlement-ledger sink exactly once per settled
 * premiere, with the correct winner/placements/matchKind/prices, the
 * moment predictions resolve; records an honest `refunded` outcome for a
 * void market instead of staying silent; and never fires on any path
 * other than the market reaching `"settled"`.
 *
 * The "unattended settlement" block below additionally proves this against
 * the REAL `ReplayPremiereSettlementLedger`/`ReplayPremierePointsLedger`
 * sinks (not the `fakeSettlementLedger()` stub the rest of this file uses)
 * with ZERO client polling driving the resolution call — see the
 * 2026-08-02 production incident this closes in
 * `docs/project-state/known-problems.md`: a real natural settlement with
 * zero active real-participant sessions never wrote its durable settlement
 * record, and the fake sink's schema-free stub had let that gap ship
 * undetected.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PremiereCanonicalAuthoritativeResult } from "../../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereSettlementLedgerRecorder,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { ReplayPremierePointsLedger } from "../../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";
import { ReplayPremiereSettlementLedger } from "../../../../src/server/replay-premiere/points/ReplayPremiereSettlementLedger";

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
  pointsLedger?: ConstructorParameters<
    typeof ReplayPremiereInteractions
  >[0]["pointsLedger"],
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
      {
        seatId: "seat-1",
        displayName: "Alpha",
        won: winningSeatId === "seat-1",
      },
      {
        seatId: "SEAT0001",
        displayName: "Beta",
        won: winningSeatId === "SEAT0001",
      },
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
    const second =
      await h.interactions.resolvePredictionsFromAuthoritativeResult({
        result,
        resolvedAt: h.now(),
      });
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

describe("ReplayPremiereInteractions unattended settlement — real (non-fake) durable sinks", () => {
  // The 2026-08-02 production incident this closes: a real natural
  // settlement with zero real-participant sessions and zero external
  // `/market` polling never wrote its settlement-ledger record. These
  // tests exercise the ACTUAL `ReplayPremiereSettlementLedger`/
  // `ReplayPremierePointsLedger` classes (schema validation included),
  // pointed at a real temp-dir filesystem root, driven by nothing but a
  // single `resolvePredictionsFromAuthoritativeResult` call — the same
  // call the internal release-clock ticker (`ReplayPremiereRuntimeSupervisor`)
  // makes on its own schedule with no client ever polling anything.
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "unattended-settlement-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("zero real participants (synthetic-crowd-only market): the real settlement ledger still durably records the winner", async () => {
    const settlementLedger = await ReplayPremiereSettlementLedger.open(root);
    const h = harness(settlementLedger);

    // Only a synthetic-crowd trade — the exact production shape: real
    // guests never showed up, only `sim_*` bettors funded the market.
    const simSession = await h.interactions.createViewerSession({
      participantId: `sim_${"c".repeat(32)}`,
      idempotencyKey: "idem_session_sim_0001",
      requesterBucketId: `ip_${"2".repeat(32)}`,
      visible: false,
      observedSequence: 35,
      excludedAsOperator: false,
      excludedAsBot: true,
    });
    await h.interactions.submitMarketOrder({
      participantId: `sim_${"c".repeat(32)}`,
      participantKind: "synthetic",
      sessionId: simSession.session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 200,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_sim_0001",
      requesterBucketId: `ip_${"2".repeat(32)}`,
    });
    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");

    // No poll, no read, nothing external — resolution alone must durably
    // write the record.
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult({ winner: ["player", "seat-1"] }),
      resolvedAt: h.now(),
    });

    const record = await settlementLedger.readSettlement(premiereId);
    expect(record).not.toBeNull();
    expect(record?.outcome).toBe("winner");
    expect(record?.winnerSeatId).toBe("seat-1");
    expect(record?.winnerDisplayName).toBe("Alpha");
    // Zero REAL (guest_*) participants funded this market — synthetic
    // crowd trades correctly don't count, and the record still exists.
    expect(record?.totalParticipants).toBe(0);
  });

  test("a real trader present, zero external polling: both the points ledger and the settlement ledger are durably written by resolution alone", async () => {
    const settlementLedger = await ReplayPremiereSettlementLedger.open(root);
    const pointsLedger = await ReplayPremierePointsLedger.open(root);
    const h = harness(settlementLedger, pointsLedger);

    const realSession = await session(
      h,
      guestA,
      "idem_session_real_unattended",
    );
    await h.interactions.submitMarketOrder({
      participantId: guestA,
      participantKind: "real",
      sessionId: realSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 200,
      limitPrice: 90,
      sequence: 80,
      idempotencyKey: "idem_order_real_unattended",
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });
    await closeBothCheckpoints(h);
    h.setPremiereState("revealed");

    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult({ winner: ["player", "seat-1"] }),
      resolvedAt: h.now(),
    });

    const settlementRecord = await settlementLedger.readSettlement(premiereId);
    expect(settlementRecord).not.toBeNull();
    expect(settlementRecord?.winnerSeatId).toBe("seat-1");
    expect(settlementRecord?.totalParticipants).toBe(1);

    const pointsEntry = await pointsLedger.readParticipant(guestA);
    expect(pointsEntry).not.toBeNull();
  });

  test("real Coworld episodeRequestId shape (a bare UUID, no ereq_ prefix) is accepted — the exact value that 404'd every real settlement before this fix", async () => {
    // 2026-08-02 production incident, root-caused via a live probe against
    // the real Coworld API: `PremiereWageringSourceBundle.ts`'s
    // `rosterFile.episodeRequestId` (fed into `sourceId` here) is
    // `str(epi.episode_id)` from the Coworld Python SDK's
    // `get_episode_request()` — a bare UUID, e.g.
    // `749516f2-4ab4-4fe0-a6ef-1bbc956c5e14`, NEVER `ereq_`-prefixed. The
    // OLD `EPISODE_REQUEST_ID_PATTERN` (`/^ereq_.../`) rejected every real
    // one of these via `storedRecordSchema.parse()`, throwing inside
    // `ReplayPremiereSettlementLedger.recordSettlement` and getting
    // silently swallowed by `recordSettlementLedgerIfNeeded`'s catch — so
    // this MUST run against the REAL (non-fake) ledger to catch it; the
    // `fakeSettlementLedger()` stub used above never validates anything.
    const settlementLedger = await ReplayPremiereSettlementLedger.open(root);
    const h = harness(settlementLedger);

    await tradeAndResolve(
      h,
      authoritativeResult({
        winner: ["player", "seat-1"],
        sourceKind: "coworld_result",
        sourceId: "749516f2-4ab4-4fe0-a6ef-1bbc956c5e14",
      }),
    );

    const record = await settlementLedger.readSettlement(premiereId);
    expect(record).not.toBeNull();
    expect(record?.episodeRequestId).toBe(
      "749516f2-4ab4-4fe0-a6ef-1bbc956c5e14",
    );
    expect(record?.matchKind).toBe("real-league");
    expect(record?.winnerSeatId).toBe("seat-1");
  });
});
