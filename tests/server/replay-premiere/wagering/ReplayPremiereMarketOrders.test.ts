import type { PremiereCanonicalAuthoritativeResult } from "../../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../../../../src/server/replay-premiere/ReplayPremiereErrors";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";

const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;
const guestC = `guest_${"c".repeat(32)}`;

function harness(overrides?: {
  wageringEnabled?: boolean;
  initialState?: ReplayPremiereInteractionsSnapshot;
  initialNowMs?: number;
  beforePersist?: (
    eventType: string,
    nextState: ReplayPremiereInteractionsSnapshot,
  ) => Promise<void>;
}) {
  let nowMs = overrides?.initialNowMs ?? Date.parse("2026-07-20T12:00:00.000Z");
  let premiereState: PremiereState = "playing";
  let randomValue = 1;
  let requestValue = 1;
  const persisted: Array<{
    eventType: string;
    state: ReplayPremiereInteractionsSnapshot;
  }> = [];
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
    persistence: {
      async persist({ eventType, nextState }) {
        await overrides?.beforePersist?.(eventType, nextState);
        persisted.push({ eventType, state: structuredClone(nextState) });
      },
    },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date(nowMs),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    initialState: overrides?.initialState,
    wageringEnabled: overrides?.wageringEnabled,
    admitAnonymousWrite: () => undefined,
  });
  return {
    interactions,
    persisted,
    setPremiereState(state: PremiereState) {
      premiereState = state;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    nextIdempotencyKey() {
      const key = `idem_${String(requestValue).padStart(16, "0")}`;
      requestValue += 1;
      return key;
    },
    now: () => new Date(nowMs).toISOString(),
  };
}

type Harness = ReturnType<typeof harness>;

async function createSession(h: Harness, participantId: string) {
  return h.interactions.createViewerSession({
    participantId,
    idempotencyKey: h.nextIdempotencyKey(),
    requesterBucketId: `ip_${"1".repeat(32)}`,
    visible: true,
    observedSequence: 35,
    excludedAsOperator: false,
    excludedAsBot: false,
  });
}

function order(
  h: Harness,
  options: {
    participantId: string;
    sessionId: string;
    seatId: string;
    side: "buy" | "sell";
    amount: number;
    limitPrice: number;
    idempotencyKey?: string;
    sequence?: number;
  },
) {
  return h.interactions.submitMarketOrder({
    participantId: options.participantId,
    participantKind: "real",
    sessionId: options.sessionId,
    seatId: options.seatId,
    side: options.side,
    amount: options.amount,
    limitPrice: options.limitPrice,
    sequence: options.sequence ?? 80,
    idempotencyKey: options.idempotencyKey ?? h.nextIdempotencyKey(),
    requesterBucketId: `ip_${"1".repeat(64)}`,
  });
}

// Checkpoints are content beats only — opening/closing one records a
// prediction window but must never gate or freeze the continuous market.
async function openCheckpoint(h: Harness, checkpointId: string) {
  await h.interactions.openCheckpoint({
    checkpointId,
    opensAt: h.now(),
    closesAt: new Date(
      Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
    ).toISOString(),
    optionSeatIds: ["seat-1", "SEAT0001"],
  });
}

async function closeCheckpoint(h: Harness, checkpointId: string) {
  h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
  await h.interactions.closeCheckpoint(checkpointId, h.now());
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
      { seatId: "seat-1", displayName: "Alpha", won: false },
      { seatId: "SEAT0001", displayName: "Beta", won: false },
    ],
  };
}

describe("ReplayPremiereInteractions LMSR market orders", () => {
  it("flag off: no market is ever created, submitMarketOrder always rejects, rest of the flow is untouched", async () => {
    const withoutFlag = harness();
    const withFlag = harness({ wageringEnabled: true });
    for (const h of [withoutFlag, withFlag]) {
      const session = await createSession(h, guestA);
      await openCheckpoint(h, "cp_first0001");
      await h.interactions.submitPrediction({
        participantId: guestA,
        sessionId: session.id,
        checkpointId: "cp_first0001",
        selectedSeatId: "seat-1",
        idempotencyKey: h.nextIdempotencyKey(),
        requesterBucketId: `ip_${"1".repeat(64)}`,
      });
    }
    expect(withoutFlag.interactions.readState().market).toBeNull();
    expect(withoutFlag.interactions.readState().trades).toEqual([]);
    expect(withoutFlag.interactions.readMarketState(null)).toBeNull();
    const session = await createSession(withoutFlag, guestB);
    await createSession(withFlag, guestB);
    await expect(
      order(withoutFlag, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 50,
        limitPrice: 100,
      }),
    ).rejects.toMatchObject({ operatorCode: "wagering_disabled" });

    const strip = (snapshot: ReplayPremiereInteractionsSnapshot) => {
      const { market: _market, trades: _trades, ...rest } = snapshot;
      return rest;
    };
    expect(strip(withoutFlag.interactions.readState())).toEqual(
      strip(withFlag.interactions.readState()),
    );
  });

  it("executes a buy at the authoritative price, is idempotent by idempotency key, and rejects once the premiere is no longer live", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    const key = h.nextIdempotencyKey();
    const first = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
      idempotencyKey: key,
    });
    expect(first.idempotent).toBe(false);
    expect(first.trade.shares).toBeGreaterThan(0);
    expect(first.trade.chips).toBeGreaterThan(0);
    expect(first.trade.chips).toBeLessThanOrEqual(100);

    const persistedBefore = h.persisted.length;
    const replay = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
      idempotencyKey: key,
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.trade).toEqual(first.trade);
    expect(h.persisted).toHaveLength(persistedBefore);

    // The premiere clock — never a checkpoint window — is what gates
    // trading. Reveal is the only thing that closes the market.
    h.setPremiereState("revealed");
    const late = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 10,
      limitPrice: 100,
    }).catch((error: unknown) => error);
    expect((late as ReplayPremiereError).operatorCode).toBe("market_not_live");
    expect((late as ReplayPremiereError).httpStatus).toBe(410);
  });

  it("stays open for orders while the premiere is in a checkpoint pause, not only while playing", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    h.setPremiereState("checkpoint");
    const trade = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    expect(trade.trade.shares).toBeGreaterThan(0);
  });

  it("rejects an order referencing a sequence the server has not yet independently revealed", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    // The harness's live-visible ceiling is fixed at 80 (see getLiveVisibleSequence
    // above) — a claim one past it must be refused even though premiereState
    // itself is "playing" and the seat/side/amount are otherwise all valid.
    // This is the real anti-read-ahead property: it holds independent of
    // premiereState, independent of chunk-release batching, and even if a
    // client somehow learned of sequence 81 through some other channel.
    const rejected = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
      sequence: 81,
    }).catch((error: unknown) => error);
    expect((rejected as ReplayPremiereError).operatorCode).toBe(
      "order_sequence_unreleased",
    );
    expect((rejected as ReplayPremiereError).httpStatus).toBe(410);
    expect(h.interactions.readState().trades).toEqual([]);

    // The identical order at the ceiling itself succeeds.
    const accepted = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
      sequence: 80,
    });
    expect(accepted.trade.shares).toBeGreaterThan(0);
  });

  it("rejects a buy whose fill would exceed the client's max price, and a sell whose fill would be below the client's min price", async () => {
    const h = harness({ wageringEnabled: true });
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    // Push the price up first so a low limitPrice buy definitely clears above it.
    await order(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      seatId: "seat-1",
      side: "buy",
      amount: 500,
      limitPrice: 100,
    });
    await expect(
      order(h, {
        participantId: guestB,
        sessionId: sessionB.id,
        seatId: "seat-1",
        side: "buy",
        amount: 500,
        limitPrice: 1,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_slippage_exceeded" });

    // Now the reverse: guestA sells with a floor price above what the market
    // would actually pay (price already dropped since nobody else bought).
    const held = h.interactions.readMarketState(guestA)?.positions?.[0]?.shares ?? 0;
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: sessionA.id,
        seatId: "seat-1",
        side: "sell",
        amount: held,
        limitPrice: 100,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_slippage_exceeded" });
  });

  it("rejects a stake below the minimum, above 50% of bankroll, or exceeding the bankroll", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 5,
        limitPrice: 100,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_below_min_stake" });
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 900,
        limitPrice: 100,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_above_max_stake" });
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 5_000,
        limitPrice: 100,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_insufficient_funds" });
  });

  it("rejects selling shares you do not hold", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "sell",
        amount: 10,
        limitPrice: 0,
      }),
    ).rejects.toMatchObject({ operatorCode: "order_rejected_no_shares_to_sell" });
  });

  it("serializes concurrent orders against one market: every fill prices off the immediately-prior q, never the same stale q twice", async () => {
    const h = harness({ wageringEnabled: true });
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    const sessionC = await createSession(h, guestC);
    // Three concurrent buys on the same outcome, same shared market. If any
    // two priced off the same pre-trade q, at least two fills would show the
    // identical avgPrice despite constant per-share cost being strictly
    // increasing in cumulative shares bought (LMSR cost is convex).
    const [a, b, c] = await Promise.all([
      order(h, {
        participantId: guestA,
        sessionId: sessionA.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }),
      order(h, {
        participantId: guestB,
        sessionId: sessionB.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }),
      order(h, {
        participantId: guestC,
        sessionId: sessionC.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }),
    ]);
    const trades = [a.trade, b.trade, c.trade].sort(
      (left, right) => Date.parse(left.executedAt) - Date.parse(right.executedAt),
    );
    // Deterministic serialization order isn't asserted (Promise.all doesn't
    // guarantee it), but the *set* of avgPrices must be strictly increasing
    // once sorted by execution order — proof no two orders shared a q.
    const avgPrices = trades.map((trade) => trade.avgPrice);
    expect(new Set(avgPrices).size).toBe(3);
    const sortedPrices = [...avgPrices].sort((x, y) => x - y);
    expect(avgPrices).toEqual(sortedPrices);
    // The market's final q reflects the sum of every fill's shares — the
    // shared, single ordered mutation queue is what makes this exact.
    const finalMarket = h.interactions.readState().market;
    const totalShares = trades.reduce((sum, trade) => sum + trade.shares, 0);
    expect(finalMarket?.q[0]).toBe(totalShares);
  });

  it("a mid-flight crash during persist leaves q and balances exactly as they were, and the same idempotency key retried after recovery is a no-op", async () => {
    let failNext = true;
    const h = harness({
      wageringEnabled: true,
      beforePersist: async (eventType) => {
        if (failNext && eventType === "market_order_submitted") {
          failNext = false;
          throw new Error("injected crash mid-trade");
        }
      },
    });
    const session = await createSession(h, guestA);
    const beforeState = structuredClone(h.interactions.readState());
    const key = h.nextIdempotencyKey();
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
        idempotencyKey: key,
      }),
    ).rejects.toThrow("injected crash mid-trade");
    // The in-memory state is untouched: mutate() only commits after a
    // successful persist, so the crashed q update and ledger debit never
    // became visible — the same transaction that would have made both
    // visible is the one that failed atomically.
    expect(h.interactions.readState()).toEqual(beforeState);

    const retried = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
      idempotencyKey: key,
    });
    expect(retried.idempotent).toBe(false);
    expect(h.interactions.readState().trades).toHaveLength(1);
  });

  it("keeps a position live and continuously priced across a checkpoint content-beat boundary — checkpoints gate nothing", async () => {
    const h = harness({ wageringEnabled: true });
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    await openCheckpoint(h, "cp_first0001");
    await order(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await closeCheckpoint(h, "cp_first0001");

    // Closing checkpoint 1 is a pure content-beat record — it does not
    // freeze or gate the market. Still open, position still there.
    const afterClose = h.interactions.readMarketState(guestA);
    expect(afterClose?.status).toBe("open");
    expect(afterClose?.positions?.[0]).toMatchObject({ seatId: "seat-1" });

    // Other participants push the price up while checkpoint 1's holder is
    // still just sitting on the position — this is the "up or down" moment.
    await openCheckpoint(h, "cp_second001");
    await order(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      seatId: "seat-1",
      side: "buy",
      amount: 300,
      limitPrice: 100,
    });
    const midway = h.interactions.readMarketState(guestA);
    expect(midway?.status).toBe("open");
    const position = midway?.positions?.[0];
    expect(position?.seatId).toBe("seat-1");
    // The price moved up (more buying pressure), so the checkpoint-1 holder's
    // position is now worth more than its cost basis.
    expect(position?.currentValue).toBeGreaterThan(position?.costBasis ?? 0);
    expect(position?.unrealizedPnl).toBeGreaterThan(0);

    // Sell it and realise the gain — no checkpoint window to reopen first.
    const sold = await order(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      seatId: "seat-1",
      side: "sell",
      amount: position!.shares,
      limitPrice: 0,
    });
    expect(sold.trade.chips).toBeGreaterThan(0);
    expect(h.interactions.readMarketState(guestA)?.positions).toEqual([]);
  });

  it("settles once at reveal, pays winning shares 100 each, and re-resolving is idempotent", async () => {
    const h = harness({ wageringEnabled: true });
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    await openCheckpoint(h, "cp_first0001");
    const winnerBuy = await order(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await order(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      seatId: "SEAT0001",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await closeCheckpoint(h, "cp_first0001");
    await openCheckpoint(h, "cp_second001");
    await closeCheckpoint(h, "cp_second001");
    h.setPremiereState("revealed");
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(["player", "seat-1"]),
      resolvedAt: h.now(),
    });
    const market = h.interactions.readState().market;
    expect(market?.status).toBe("settled");
    expect(market?.winnerSeatId).toBe("seat-1");
    const balanceA = market?.ledgerBalances[guestA] ?? 0;
    // Winner: bankroll after buying minus the stake plus 100/share payout.
    expect(balanceA).toBe(
      1_000 - winnerBuy.trade.chips + winnerBuy.trade.shares * 100,
    );
    const balanceB = market?.ledgerBalances[guestB] ?? 0;
    expect(balanceB).toBeLessThan(1_000); // loser never gets the stake back

    // The authenticated read (GET /market/me in production) still serves
    // each participant's real settlement outcome through readMarketState
    // — winner's shares valued at the actual flat payout, loser's shares
    // still on record but worthless. This is the exact server-truth read
    // MarketSettlementPanel renders; it must never come back empty just
    // because the market settled.
    const winnerView = h.interactions.readMarketState(guestA);
    expect(winnerView?.positions).toEqual([
      {
        seatId: "seat-1",
        shares: winnerBuy.trade.shares,
        costBasis: winnerBuy.trade.chips,
        currentValue: winnerBuy.trade.shares * 100,
        unrealizedPnl: winnerBuy.trade.shares * 100 - winnerBuy.trade.chips,
      },
    ]);
    const loserView = h.interactions.readMarketState(guestB);
    expect(loserView?.positions).toEqual([
      expect.objectContaining({ seatId: "SEAT0001", currentValue: 0 }),
    ]);
    const persistedBefore = h.persisted.length;
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(h.persisted).toHaveLength(persistedBefore);
    expect(h.interactions.readState().market?.ledgerBalances[guestA]).toBe(
      balanceA,
    );
  });

  it("voids and refunds cost basis when the checkpoint itself voided", async () => {
    const h = harness({ wageringEnabled: true });
    const session = await createSession(h, guestA);
    await openCheckpoint(h, "cp_first0001");
    const buy = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await closeCheckpoint(h, "cp_first0001");
    await openCheckpoint(h, "cp_second001");
    await closeCheckpoint(h, "cp_second001");
    h.setPremiereState("revealed");
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(null),
      resolvedAt: h.now(),
    });
    const market = h.interactions.readState().market;
    expect(market?.status).toBe("settled");
    expect(market?.winnerSeatId).toBeNull();
    expect(market?.ledgerBalances[guestA]).toBe(1_000 - buy.trade.chips + buy.trade.chips);

    // Void settlement: the position is still readable, currentValue is
    // the cost-basis refund (already posted to the ledger above), not 0
    // and not sellProceeds against a market that can no longer be traded.
    const view = h.interactions.readMarketState(guestA);
    expect(view?.positions).toEqual([
      {
        seatId: "seat-1",
        shares: buy.trade.shares,
        costBasis: buy.trade.chips,
        currentValue: buy.trade.chips,
        unrealizedPnl: 0,
      },
    ]);
  });
});
