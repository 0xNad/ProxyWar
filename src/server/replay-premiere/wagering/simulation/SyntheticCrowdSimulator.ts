/**
 * Synthetic-bettor ("crowd") simulator.
 *
 * With thin real liquidity a market barely moves and the product feels
 * dead. This simulator drives a deterministic, seeded crowd of synthetic
 * bettors that trades the SAME server-authoritative order queue real
 * participants use (`submitMarketOrder` on `ReplayPremiereInteractions`,
 * with the exact session-ownership + idempotency-key discipline every
 * other write in this codebase already uses). There is no bot-only bypass:
 * if the crowd could mutate `q` or the ledger directly, the server's
 * per-market trade queue and its atomic q+ledger commits would be a
 * fiction and the ledger would drift.
 *
 * Ported from the prior single-player engine's `engine/crowd.ts` — bots
 * compare a market price to a fair-value signal and buy under-priced /
 * sell over-priced with bounded stakes — NOT reinvented. Trading here is
 * CONTINUOUS: the match plays live, tick by tick, and the market stays
 * open for the whole match (no checkpoint-window gating — checkpoints are
 * content beats, not trading gates). This is actually closer to the prior
 * engine's original shape than an earlier windowed design this module went
 * through: the caller drives `onReleasedFrame` once per newly-released
 * frame, exactly like the prior engine's `Crowd.step(frame)` being called
 * once per game tick.
 *
 * The one non-negotiable integrity property carries over unchanged: the
 * crowd may only ever act on what has actually been released. It never
 * gets a live accessor, callback, or runtime reference — `onReleasedFrame`
 * takes a plain, caller-supplied `SyntheticCrowdSignalSnapshot` for THIS
 * frame only, and this class has no other way to observe game/replay
 * state. The caller is responsible for calling it with strictly
 * forward-progressing, never-beyond-released frames (the same
 * server-authoritative release clock that already gates what predictions
 * and reactions can see) — if it only ever hands the crowd what has been
 * released so far, the crowd cannot leak what it was never given.
 *
 * This is scaffolding for demos and tester sessions, not a permanent
 * feature — it exists solely to make thin markets legible while testing
 * and MUST stay off (`config.enabled === false`, the default) in anything
 * resembling production. Every synthetic account trades under a
 * `sim_[a-f0-9]{32}` participant id, structurally disjoint from the real
 * `guest_[a-f0-9]{32}` namespace, and every resulting trade record carries
 * `participantKind: "synthetic"` on the server side — real-vs-synthetic
 * stakes are always an exact projection of the trade list, never a side
 * convention this module has to remember to maintain.
 */
import { syntheticCrowdActivityDensity } from "./SyntheticCrowdActivityCurve";
import { decideSyntheticCrowdOrder } from "./SyntheticCrowdPersonas";
import { Prng } from "./SyntheticCrowdPrng";
import type {
  SyntheticCrowdConfig,
  SyntheticCrowdFrameResult,
  SyntheticCrowdLogEntry,
  SyntheticCrowdMarketTarget,
  SyntheticCrowdOrderSkipReason,
  SyntheticCrowdPersonaKind,
  SyntheticCrowdSignalSnapshot,
} from "./SyntheticCrowdTypes";

interface SyntheticCrowdBettorState {
  readonly index: number;
  readonly participantId: string;
  readonly persona: SyntheticCrowdPersonaKind;
  readonly requesterBucketId: string;
  sessionId: string | null;
  remainingBudgetHint: number;
  heldShares: Record<string, number>;
  lastSeenPrices: Record<string, number> | null;
  orderSequence: number;
}

function hexDigits(rng: Prng, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += rng.nextInt(0, 15).toString(16);
  }
  return out;
}

function drawPersona(
  rng: Prng,
  weights: Readonly<Record<SyntheticCrowdPersonaKind, number>>,
): SyntheticCrowdPersonaKind {
  const entries = Object.entries(weights) as [SyntheticCrowdPersonaKind, number][];
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) {
    return entries[0][0];
  }
  let draw = rng.next() * total;
  for (const [persona, weight] of entries) {
    draw -= Math.max(0, weight);
    if (draw <= 0) {
      return persona;
    }
  }
  return entries[entries.length - 1][0];
}

export class SyntheticCrowdSimulator {
  private readonly config: SyntheticCrowdConfig;
  private readonly target: SyntheticCrowdMarketTarget;
  private readonly rng: Prng;
  private readonly roster: SyntheticCrowdBettorState[];

  constructor(options: { config: SyntheticCrowdConfig; target: SyntheticCrowdMarketTarget }) {
    this.config = options.config;
    this.target = options.target;
    this.rng = new Prng(options.config.seed);
    this.roster = [];
    for (let i = 0; i < options.config.count; i++) {
      this.roster.push({
        index: i,
        participantId: `sim_${hexDigits(this.rng, 32)}`,
        persona: drawPersona(this.rng, options.config.personaWeights),
        requesterBucketId: `ip_${hexDigits(this.rng, 32)}`,
        sessionId: null,
        // Bankroll diversity: each bot's hint is 0.5x-1.5x the configured
        // average, seeded — "some richer, some poorer" instead of a flat,
        // uniform crowd. (The server grants every account the same flat
        // STARTING_BANKROLL on first trade; this hint governs how
        // aggressively each bot spends it, which is where the diversity
        // actually shows up.)
        remainingBudgetHint: Math.round(
          options.config.bankrollEach * (0.5 + this.rng.next()),
        ),
        heldShares: {},
        lastSeenPrices: null,
        orderSequence: 0,
      });
    }
  }

  /** Deterministic synthetic participant ids this run will trade under — for tests/logging/audit; never mutated by callers. */
  get participantIds(): readonly string[] {
    return this.roster.map((bettor) => bettor.participantId);
  }

  /**
   * Gives every bot one shot at trading on a single newly-released frame.
   * `snapshot` MUST reflect only what has actually been released as of
   * this call — see the class header. `matchProgress` (0..1) shapes each
   * bot's trade-attempt probability via the configured activity curve.
   * No-op (returns an empty log) when `config.enabled` is false.
   */
  async onReleasedFrame(options: {
    snapshot: SyntheticCrowdSignalSnapshot;
    matchProgress: number;
    observedSequence: number;
  }): Promise<SyntheticCrowdFrameResult> {
    if (!this.config.enabled) {
      return { matchProgress: options.matchProgress, entries: [] };
    }
    const density = syntheticCrowdActivityDensity(
      this.config.activityCurve,
      options.matchProgress,
    );
    const attemptProbability = Math.min(
      1,
      Math.max(0, this.config.activityProbability * density),
    );
    const entries: SyntheticCrowdLogEntry[] = [];
    for (const bettor of this.roster) {
      entries.push(await this.actOne(bettor, attemptProbability, options));
    }
    return { matchProgress: options.matchProgress, entries };
  }

  private async actOne(
    bettor: SyntheticCrowdBettorState,
    attemptProbability: number,
    frame: {
      snapshot: SyntheticCrowdSignalSnapshot;
      matchProgress: number;
      observedSequence: number;
    },
  ): Promise<SyntheticCrowdLogEntry> {
    const base = {
      botIndex: bettor.index,
      participantId: bettor.participantId,
      persona: bettor.persona,
      matchProgress: frame.matchProgress,
    } as const;
    const skip = (
      reason: SyntheticCrowdOrderSkipReason,
      detail?: string,
    ): SyntheticCrowdLogEntry => ({ kind: "skip", ...base, reason, detail });

    if (!this.rng.chance(attemptProbability)) {
      return skip("inactive");
    }
    const state = this.target.readMarketState(null);
    if (state === null || state.status !== "open") {
      return skip("market_not_open");
    }
    const marketPrices: Record<string, number> = {};
    state.outcomeSeatIds.forEach((seatId, i) => {
      marketPrices[seatId] = state.prices[i] ?? 0;
    });
    const decision = decideSyntheticCrowdOrder({
      persona: bettor.persona,
      snapshot: frame.snapshot,
      marketPrices,
      heldShares: bettor.heldShares,
      lastSeenPrices: bettor.lastSeenPrices,
      remainingBudgetHint: bettor.remainingBudgetHint,
      minStake: this.config.minStake,
      maxStake: this.config.maxStake,
      threshold: this.config.threshold,
      aggressiveness: this.config.aggressiveness,
      rng: this.rng,
    });
    bettor.lastSeenPrices = marketPrices;
    if (decision === null) {
      return skip("no_signal");
    }
    try {
      if (bettor.sessionId === null) {
        const session = await this.target.createViewerSession({
          participantId: bettor.participantId,
          idempotencyKey: this.nextIdempotencyKey(bettor, "sess"),
          requesterBucketId: bettor.requesterBucketId,
          visible: true,
          observedSequence: frame.observedSequence,
          excludedAsOperator: false,
          // Never counted toward real qualified-viewer metrics or shown as
          // a real person anywhere the platform already respects this flag.
          excludedAsBot: true,
        });
        bettor.sessionId = session.id;
      }
      const { trade } = await this.target.submitMarketOrder({
        participantId: bettor.participantId,
        participantKind: "synthetic",
        sessionId: bettor.sessionId,
        idempotencyKey: this.nextIdempotencyKey(bettor, "ord"),
        requesterBucketId: bettor.requesterBucketId,
        seatId: decision.seatId,
        side: decision.side,
        sequence: state.liveVisibleSequence,
        amount: decision.amount,
        limitPrice: decision.limitPrice,
      });
      bettor.heldShares[decision.seatId] =
        (bettor.heldShares[decision.seatId] ?? 0) +
        (decision.side === "buy" ? trade.shares : -trade.shares);
      bettor.remainingBudgetHint -=
        decision.side === "buy" ? trade.chips : -trade.chips;
      return {
        kind: "order",
        ...base,
        side: trade.side,
        seatId: trade.seatId,
        shares: trade.shares,
        chips: trade.chips,
        avgPrice: trade.avgPrice,
      };
    } catch (error) {
      return skip(
        "order_rejected",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private nextIdempotencyKey(
    bettor: SyntheticCrowdBettorState,
    tag: "sess" | "ord",
  ): string {
    bettor.orderSequence += 1;
    return `simcrowd_${tag}_${String(bettor.index).padStart(4, "0")}_${String(
      bettor.orderSequence,
    ).padStart(8, "0")}`;
  }
}
