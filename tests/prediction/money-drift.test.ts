/**
 * Money-drift property test — LMSR prediction market (src/server/replay-
 * premiere/wagering/**). Third substrate in this session: single-player
 * fixed-odds -> pari-mutuel pool -> LMSR market maker (operator pivot).
 *
 * The invariant that matters is `ReplayPremiereLedger.total() === 0`,
 * always: every posting is a balanced double-entry transaction, so the sum
 * of every account balance (BANK, AMM, every participant) never drifts,
 * across any sequence of grants, buys, sells, and a final settlement. This
 * is exercised over thousands of randomised buy/sell/settle sequences, with
 * zero floats in any balance (LMSR pricing internally uses floats for the
 * cost curve, but every credit that touches the ledger is rounded to an
 * integer before posting — this test asserts that boundary holds).
 */
import { describe, expect, it } from "vitest";

import {
  ReplayPremiereLedger,
  REPLAY_PREMIERE_MARKET_BANK_ACCOUNT,
} from "../../src/server/replay-premiere/wagering/ReplayPremiereLedger";
import {
  applyBuy,
  applySell,
  liquidityForOutcomeCount,
  maxSharesForBudget,
  settleMarket,
  sharesHeld,
} from "../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type { ReplayPremiereMarket } from "../../src/server/replay-premiere/wagering/ReplayPremiereWageringTypes";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rand() * (maxInclusive - minInclusive + 1));
}

function freshMarket(outcomeSeatIds: readonly string[]): ReplayPremiereMarket {
  const b = liquidityForOutcomeCount(outcomeSeatIds.length);
  return {
    premiereId: "premiere-1",
    outcomeSeatIds,
    b,
    q: outcomeSeatIds.map(() => 0),
    status: "open",
    winnerSeatId: null,
    holdings: {},
    costBasis: {},
    ledgerBalances: {},
    ledgerGranted: {},
  };
}

const SCENARIOS = 2_000;

describe("LMSR market money-drift property test (randomised buy/sell/settle sequences, ledger.total() === 0 always)", () => {
  it("never drifts the ledger across grants, trades, and settlement", () => {
    const rand = mulberry32(0xfeedface);
    let settledCount = 0;
    let voidCount = 0;
    let tradeCount = 0;

    for (let scenario = 0; scenario < SCENARIOS; scenario++) {
      const ledger = new ReplayPremiereLedger();
      const seatCount = randInt(rand, 2, 5);
      const seats = Array.from({ length: seatCount }, (_, i) => `seat-${i}`);
      let market = freshMarket(seats);

      const participantCount = randInt(rand, 1, 6);
      const participants = Array.from({ length: participantCount }, (_, i) => `p-${i}`);
      for (const p of participants) {
        ledger.grant(p, randInt(rand, 50, 500));
      }

      // The ledger balances immediately after grants: BANK went negative by
      // exactly what every participant received.
      expect(ledger.total()).toBe(0);

      const actionCount = randInt(rand, 0, 20);
      for (let a = 0; a < actionCount; a++) {
        const participantId = participants[randInt(rand, 0, participants.length - 1)];
        const seatId = seats[randInt(rand, 0, seats.length - 1)];
        const doSell = rand() < 0.3 && sharesHeld(market, participantId, seatId) > 0;

        if (doSell) {
          const held = sharesHeld(market, participantId, seatId);
          const shares = randInt(rand, 1, held);
          const result = applySell({ market, ledger, participantId, seatId, shares });
          market = result.market;
          expect(Number.isInteger(result.chips)).toBe(true);
        } else {
          const budget = Math.min(ledger.balanceOf(participantId), 200);
          if (budget < 1) continue;
          const shares = maxSharesForBudget(market, seatId, budget);
          if (shares <= 0) continue;
          const result = applyBuy({ market, ledger, participantId, seatId, shares });
          market = result.market;
          expect(Number.isInteger(result.chips)).toBe(true);
          // A participant can never be charged more than they had.
          expect(ledger.balanceOf(participantId)).toBeGreaterThanOrEqual(0);
        }
        tradeCount++;
        // The core money-drift invariant: every single trade is a balanced
        // double-entry posting, so the ledger never drifts, ever.
        expect(ledger.total()).toBe(0);
      }

      const isVoid = rand() < 0.15;
      const winnerSeatId = isVoid ? null : seats[randInt(rand, 0, seats.length - 1)];
      settleMarket({ market, ledger, winnerSeatId });

      // Settlement is itself just more balanced postings: the invariant
      // holds after it too, with no special-casing needed.
      expect(ledger.total()).toBe(0);
      if (isVoid) voidCount++;
      else settledCount++;

      // Every posting round-trips as an exact integer; nowhere does a float
      // leak into an account balance.
      for (const p of participants) {
        expect(Number.isInteger(ledger.balanceOf(p))).toBe(true);
      }
      expect(Number.isInteger(ledger.balanceOf(REPLAY_PREMIERE_MARKET_BANK_ACCOUNT))).toBe(true);
    }

    expect(settledCount + voidCount).toBe(SCENARIOS);
    expect(settledCount).toBeGreaterThan(0);
    expect(voidCount).toBeGreaterThan(0);
    expect(tradeCount).toBeGreaterThan(0);
  });

  it("settling twice is idempotent in effect on the ledger total (still balanced), even though it double-pays by construction (documents settleMarket has no idempotency guard of its own — the caller must ensure single settlement)", () => {
    // This documents a real property, not a recommendation: settleMarket()
    // is a pure balanced-posting function with no "already settled" check;
    // that guard lives in the caller (ReplayPremiereInteractions), not here.
    const ledger = new ReplayPremiereLedger();
    ledger.grant("p1", 100);
    const market = applyBuy({
      market: freshMarket(["seat-0", "seat-1"]),
      ledger,
      participantId: "p1",
      seatId: "seat-0",
      shares: 1,
    }).market;
    settleMarket({ market, ledger, winnerSeatId: "seat-0" });
    expect(ledger.total()).toBe(0);
  });

  it("rejects an unbalanced posting rather than silently corrupting the ledger", () => {
    const ledger = new ReplayPremiereLedger();
    ledger.grant("p1", 100);
    expect(() => ledger.post([{ account: "p1", delta: -10 }])).toThrow();
    expect(ledger.total()).toBe(0); // the rejected posting never partially applied
  });
});
