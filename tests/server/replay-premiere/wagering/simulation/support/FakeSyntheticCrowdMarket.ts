/**
 * Test-only double for `SyntheticCrowdMarketTarget`. Reuses the REAL,
 * production pure market/ledger functions (`ReplayPremiereMarket.ts` /
 * `ReplayPremiereLedger.ts`) rather than re-deriving LMSR math — this is a
 * thin state holder around exactly the same mechanics
 * `ReplayPremiereInteractions.submitMarketOrder` runs, minus the
 * event-sourced snapshot/session-recovery machinery irrelevant to unit
 * tests. Trading is continuous: the market is "open" from construction
 * until `settle()` is called (no checkpoint-window gating — checkpoints
 * are content-beat attribution only, per the operator's continuous-trading
 * directive), matching production.
 */
import {
  applyBuy,
  applySell,
  computeMarketPrices,
  maxSharesForBudget,
  quoteBuy,
  quoteSell,
  settleMarket,
  sharesHeld,
} from "../../../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import {
  ReplayPremiereLedger,
} from "../../../../../../src/server/replay-premiere/wagering/ReplayPremiereLedger";
import {
  STARTING_BANKROLL,
  validateBuyStake,
} from "../../../../../../src/server/replay-premiere/wagering/ReplayPremiereMarketRules";
import type {
  ReplayPremiereMarket,
  ReplayPremiereMarketTrade,
} from "../../../../../../src/server/replay-premiere/wagering/ReplayPremiereWageringTypes";
import type { SyntheticCrowdMarketState } from "../../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";

export class FakeSyntheticCrowdMarketRejection extends Error {}

export class FakeSyntheticCrowdMarket {
  private market: ReplayPremiereMarket;
  private readonly ledger = new ReplayPremiereLedger();
  private readonly sessionsByParticipant = new Map<string, string>();
  private readonly tradesByKey = new Map<string, ReplayPremiereMarketTrade>();
  readonly trades: ReplayPremiereMarketTrade[] = [];
  private nowIso: string;
  private tradeCounter = 0;
  private sessionCounter = 0;
  /** Mirrors `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence()`. Defaults high so existing tests that never call `setVisibleSequence` are unaffected. */
  private visibleSequence = 1_000_000_000;

  constructor(options: {
    outcomeSeatIds: readonly string[];
    b: number;
    nowIso: string;
  }) {
    this.market = {
      premiereId: "prem_test0000000",
      outcomeSeatIds: options.outcomeSeatIds,
      b: options.b,
      q: options.outcomeSeatIds.map(() => 0),
      status: "open",
      winnerSeatId: null,
      holdings: {},
      costBasis: {},
      ledgerBalances: {},
      ledgerGranted: {},
    };
    this.nowIso = options.nowIso;
  }

  setNow(nowIso: string): void {
    this.nowIso = nowIso;
  }

  setVisibleSequence(sequence: number): void {
    this.visibleSequence = sequence;
  }

  ledgerTotal(): number {
    return this.ledger.total();
  }

  ledgerBalanceOf(account: string): number {
    return this.ledger.balanceOf(account);
  }

  settle(winnerSeatId: string | null): void {
    this.market = settleMarket({ market: this.market, ledger: this.ledger, winnerSeatId });
  }

  readMarketState(_participantId: string | null): SyntheticCrowdMarketState | null {
    return {
      outcomeSeatIds: this.market.outcomeSeatIds,
      b: this.market.b,
      q: this.market.q,
      prices: computeMarketPrices(this.market),
      status: this.market.status,
      winnerSeatId: this.market.winnerSeatId,
      liveVisibleSequence: this.visibleSequence,
    };
  }

  async createViewerSession(options: {
    participantId: string;
    idempotencyKey: string;
  }): Promise<{ session: { id: string } }> {
    const existing = this.sessionsByParticipant.get(options.participantId);
    if (existing !== undefined) return { session: { id: existing } };
    this.sessionCounter += 1;
    const id = `sess_${String(this.sessionCounter).padStart(4, "0")}${"0".repeat(28)}`;
    this.sessionsByParticipant.set(options.participantId, id);
    return { session: { id } };
  }

  async submitMarketOrder(options: {
    participantId: string;
    participantKind: "real" | "synthetic";
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    seatId: string;
    side: "buy" | "sell";
    sequence: number;
    amount: number;
    limitPrice: number;
  }): Promise<{ trade: ReplayPremiereMarketTrade; idempotent: boolean }> {
    const key = `${options.participantId}\u0000${options.idempotencyKey}`;
    const existing = this.tradesByKey.get(key);
    if (existing !== undefined) {
      return { trade: existing, idempotent: true };
    }
    if (this.market.status !== "open") {
      throw new FakeSyntheticCrowdMarketRejection("market_not_open");
    }
    if (options.sequence > this.visibleSequence) {
      throw new FakeSyntheticCrowdMarketRejection("order_sequence_unreleased");
    }
    if (!this.market.outcomeSeatIds.includes(options.seatId)) {
      throw new FakeSyntheticCrowdMarketRejection("unknown_seat");
    }
    if (this.ledger.grantedTo(options.participantId) === 0) {
      this.ledger.grant(options.participantId, STARTING_BANKROLL);
    }
    let shares: number;
    let chips: number;
    if (options.side === "buy") {
      const bankroll = this.ledger.balanceOf(options.participantId);
      const validation = validateBuyStake(options.amount, bankroll);
      if (!validation.ok) {
        throw new FakeSyntheticCrowdMarketRejection(`order_rejected_${validation.reason}`);
      }
      shares = maxSharesForBudget(this.market, options.seatId, options.amount);
      if (shares <= 0) {
        throw new FakeSyntheticCrowdMarketRejection("order_rejected_zero_shares");
      }
      const fill = quoteBuy(this.market, options.seatId, shares);
      if (fill.avgPrice > options.limitPrice) {
        throw new FakeSyntheticCrowdMarketRejection("order_rejected_slippage_exceeded");
      }
      const applied = applyBuy({
        market: this.market,
        ledger: this.ledger,
        participantId: options.participantId,
        seatId: options.seatId,
        shares,
      });
      this.market = applied.market;
      chips = applied.chips;
    } else {
      const held = sharesHeld(this.market, options.participantId, options.seatId);
      if (held <= 0) {
        throw new FakeSyntheticCrowdMarketRejection("order_rejected_no_shares_to_sell");
      }
      shares = Math.min(options.amount, held);
      const fill = quoteSell(this.market, options.seatId, shares);
      if (fill.avgPrice < options.limitPrice) {
        throw new FakeSyntheticCrowdMarketRejection("order_rejected_slippage_exceeded");
      }
      const applied = applySell({
        market: this.market,
        ledger: this.ledger,
        participantId: options.participantId,
        seatId: options.seatId,
        shares,
      });
      this.market = applied.market;
      chips = applied.chips;
    }
    this.tradeCounter += 1;
    const trade: ReplayPremiereMarketTrade = {
      id: `trade_${String(this.tradeCounter).padStart(6, "0")}`,
      premiereId: this.market.premiereId,
      participantId: options.participantId,
      participantKind: options.participantKind,
      seatId: options.seatId,
      side: options.side,
      shares,
      chips,
      avgPrice: shares > 0 ? chips / shares : 0,
      executedAt: this.nowIso,
      sequence: options.sequence,
      idempotencyKey: options.idempotencyKey,
    };
    this.tradesByKey.set(key, trade);
    this.trades.push(trade);
    return { trade, idempotent: false };
  }
}
