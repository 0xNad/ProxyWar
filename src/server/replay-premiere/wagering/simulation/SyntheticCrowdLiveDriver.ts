/**
 * Wires `SyntheticCrowdSimulator` into a LIVE running premiere.
 *
 * Unlike the rest of `wagering/simulation/**`, this file is NOT domain-
 * agnostic: it is the one place in the crowd stack allowed to interpret
 * match data, because it is the integration glue between the pure
 * simulator and the real, running server. `SyntheticCrowdSimulator` itself
 * still never sees anything but the plain `SyntheticCrowdSignalSnapshot`
 * this driver hands it once per poll — the structural leak-prevention
 * guarantee is unchanged, just satisfied one layer further out.
 *
 * SIGNAL: real per-seat territory share, not activity volume. An earlier
 * version of this driver derived `favorabilityWeights` from released
 * `Turn.intents[].clientID` density — "who is currently doing the most."
 * That measures the wrong variable: a busy-but-losing seat and a quiet,
 * dominant one are indistinguishable to an activity count, so the crowd
 * could (and did, in production measurement) price an already-eliminated
 * seat as the favorite while the actual territory leader traded as a long
 * shot. Territory share is what a human reading the leaderboard actually
 * uses to beat the crowd, so it's what the crowd trades on now, via
 * `SyntheticCrowdTerritoryProjection.ts`'s whole-match precompute (see
 * that module's header for why precompute instead of a live engine, and
 * `syntheticCrowdTerritorySampleAtOrBefore` for the integrity rule this
 * driver upholds: it is structurally unable to look up a sample past the
 * highest sequence `readLiveProjection` has actually released).
 *
 * Conviction, not instantaneous reads: `territoryLevel` is a long-half-life
 * exponential moving average of each seat's territory share, so a seat
 * that has genuinely led for minutes prices as a leader instead of
 * whatever one frame happened to show, and confidence is additionally
 * scaled by how much of the match has been seen — early-match evidence is
 * thin evidence even when it's real. The one exception is elimination: a
 * seat currently holding zero tiles is priced at the floor immediately,
 * bypassing the memory entirely — there is no legitimate basis for a
 * lingering high price on a seat the released data already shows is dead.
 *
 * BASELINE LIQUIDITY vs CONVICTION (2026-07-27 fix): the whole-match
 * territory precompute is a background pass with no wall-clock guarantee
 * — on an unloaded box it resolves in well under a second, but under real
 * multi-tenant CPU contention (see this module's tests) it can take
 * however long it takes, and if it fails outright the table simply never
 * arrives. Before this fix, EVERY seat read the exact same
 * `TERRITORY_FLOOR` constant while the table was unresolved, which
 * `normalizedFairValues` collapses to an EXACT tie with the market's own
 * (equally flat) opening price — a mathematically guaranteed zero gap for
 * every persona whose fair value doesn't already include its own jitter,
 * which is only "noise-trader", and with the deployed default
 * roster/seed that persona doesn't always even get drawn. The result: a
 * crowd that is "enabled" and silently produces zero trades for as long
 * as the table stays unresolved — anywhere from milliseconds to the
 * entire match, indistinguishable from outside the process. The same tie
 * reappears every time the confidence ramp (below) is near zero, since it
 * blends every seat back toward the identical `equalShare`.
 *
 * The fix is NOT to remove the ramp or the floor — early and missing
 * evidence really is weaker evidence, and the crowd must not price a seat
 * on a guess. It's to stop conflating "no conviction yet" with "no
 * baseline liquidity" — `SyntheticCrowdSimulator`'s whole reason to exist
 * (see its header) is to keep a thin market legible even absent a strong
 * signal, and a market that cannot move AT ALL until either a background
 * job finishes OR the real data itself happens to be close is not
 * legible, it's dead — and a genuinely close real match is not
 * hypothetical: a live smoke test of this fix found exactly that case,
 * every alive seat within a couple of points of every other for the
 * first ~90s of an otherwise-working match, correctly silent because
 * there was no edge yet, not because anything was broken. `baselineNoise`
 * adds a small, deterministic, freshly-redrawn-every-poll, zero-
 * directional-bias nudge to every ALIVE seat's weight in exactly two
 * cases — no territory sample exists yet at all, or one exists but every
 * alive seat's weight is already within `TERRITORY_FLAT_SIGNAL_SPREAD_THRESHOLD`
 * of every other (never the eliminated floor — see the constants' own
 * docs) — large enough to break the exact-or-near-exact tie either case
 * produces, small enough to never be mistaken for, or interfere with, a
 * real lead once one exists.
 *
 * The confidence ramp itself is deliberately left mathematically
 * unchanged from what Convergence proved (`SyntheticCrowdLiveDriver —
 * territory-driven convergence` below): every value tried for a floor on
 * it — even ones far smaller than the ramp's own natural climb —
 * measurably destabilized the elimination and sustained-lead tests,
 * because every persona in one poll tick shares a SINGLE seeded RNG
 * stream, so any change to which bot decides what on ANY early tick
 * reshuffles every draw for the rest of the match. The ramp already
 * reaches full confidence within `TERRITORY_CONFIDENCE_RAMP_PROGRESS`
 * (10%) of the match, which for the real 8-14 minute matches this
 * product runs is on the order of a minute of wall time on its own —
 * the multi-minute silence this fix exists to close was never explained
 * by the ramp holding steady at zero; it was explained by the null-
 * sample branch above holding at an EXACT tie for as long as the
 * precompute stayed unresolved, unboundedly. Closing that is sufficient;
 * touching the ramp besides is not free.
 *
 * Silence is also now impossible to miss rather than merely rare: once
 * this driver has anything to react to (the first poll with newly
 * released content), if a full minute passes with zero trades from any
 * bot, it reports exactly why — precompute still pending, precompute
 * failed (with the underlying error), or (the now-expected-to-be-rare
 * residual case) data available but nothing has cleared the crowd's
 * threshold — through `onError`, once. A crowd that looks like it's
 * working when it silently isn't is exactly the failure this exists to
 * end.
 *
 * Off by default. Gated by the caller (see `ReplayPremiereStartup.ts`'s
 * `syntheticCrowdEnabled` option) behind the exact same discipline as
 * `wageringEnabled`: a premiere with the flag off never constructs this
 * driver at all and behaves byte-identically to today.
 */
import type { PremiereReleasedRecord } from "../../ReplayPremiereContracts";
import type { PremiereChunkDraft } from "../../ReplayPremiereContracts";
import type { VerifiedPremiereEligibilityGate } from "../../ReplayPremierePublication";
import { Prng } from "./SyntheticCrowdPrng";
import { SyntheticCrowdSimulator } from "./SyntheticCrowdSimulator";
import {
  syntheticCrowdTerritorySampleAtOrBefore,
  type SyntheticCrowdTerritoryProjector,
  type SyntheticCrowdTerritoryTable,
} from "./SyntheticCrowdTerritoryProjection";
import type {
  SyntheticCrowdConfig,
  SyntheticCrowdMarketTarget,
  SyntheticCrowdSignalSnapshot,
} from "./SyntheticCrowdTypes";

/** Minimal surface this driver needs from the runtime coordinator. */
export interface SyntheticCrowdLiveProjectionSource {
  readLiveVisibleSequence(): number;
  readLiveProjection(afterSequence: number): readonly PremiereReleasedRecord[];
}

export interface SyntheticCrowdLiveDriverOptions {
  readonly runtime: SyntheticCrowdLiveProjectionSource;
  readonly target: SyntheticCrowdMarketTarget;
  readonly seatIds: readonly string[];
  /** Total released-sequence count at full reveal, for a 0..1 match-progress fraction. */
  readonly finalSequence: number;
  readonly config: SyntheticCrowdConfig;
  /** Real-time poll cadence. Defaults to 1000ms — a reasonable-feeling real-time crowd tick; unrelated to any chunk-release granularity (release granularity and market-order freshness are decoupled — see `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence`'s doc comment). */
  readonly pollIntervalMs?: number;
  /** Never throws out of the poll loop; failures — and the once-only idle-crowd report below — are reported here instead. */
  readonly onError?: (error: unknown) => void;
  /**
   * Whole-match territory precompute source. `start()` kicks off ONE
   * background pass (never on the caller's critical path, never awaited by
   * the poll loop); until it resolves — or if this is omitted, or it
   * fails — the driver has no more basis for a signal than a quiet tick
   * and every seat prices at the floor plus baseline noise (see
   * `territoryBaselineNoise` below). See `SyntheticCrowdTerritoryProjection.ts`.
   */
  readonly territory?: {
    readonly projector: SyntheticCrowdTerritoryProjector;
    readonly gate: VerifiedPremiereEligibilityGate;
    readonly drafts: readonly PremiereChunkDraft[];
  };
}

/**
 * How many poll ticks it takes accumulated territory conviction to decay
 * halfway back toward a fresh reading — long enough that the ~80s gap
 * between a real late-match signal and settlement (the round-2 finding
 * that started this fix) barely dents it, short enough that a multi-
 * minute swing in an actual match still shows up well before it ends.
 */
const TERRITORY_CONVICTION_HALF_LIFE_TICKS = 60;
const TERRITORY_CONVICTION_DECAY = Math.pow(0.5, 1 / TERRITORY_CONVICTION_HALF_LIFE_TICKS);

/**
 * Fraction of the match that must have been released before territory
 * conviction is trusted at full strength. Below this, belief is blended
 * back toward "no clear leader yet" in proportion to how little of the
 * match has actually been seen — a real early lead is still real evidence
 * (unlike the old activity signal, which could be flatly wrong), but a few
 * seconds of it is still a thin sample, not a settled read.
 */
const TERRITORY_CONFIDENCE_RAMP_PROGRESS = 0.1;

/** Nonzero floor so a seat with no signal yet doesn't literally read 0 (which would collapse `normalizedFairValues` to a degenerate all-zero case); far too small to read as anything but "no evidence" against any seat with real conviction. */
const TERRITORY_FLOOR = 0.05;

/**
 * Amplitude of the baseline-liquidity noise added to a seat's weight when
 * there is no informational edge to trade on AT ALL — no territory sample
 * exists yet (`deriveSnapshot`'s `sample === null` branch). Freshly
 * redrawn every poll independently per seat, so it never accumulates into
 * a durable lead for anyone: its only job is to break the exact tie a
 * flat signal would otherwise produce against the market's own flat
 * opening price, so the crowd can express the "no real edge, but the
 * market should still breathe" behaviour `SyntheticCrowdSimulator` was
 * built for (see its header). Scaled for the null branch's own small
 * (`TERRITORY_FLOOR`-anchored) weight range — see
 * `TERRITORY_REAL_SIGNAL_NOISE_AMPLITUDE_PTS` below for the unrelated,
 * percentage-point-scaled constant the real-data branch uses; the two are
 * not interchangeable; a single amplitude used across both branches was
 * exactly the "sized correctly for one scale, negligible on the other"
 * bug the 2026-07-27 measurement below closes.
 */
const TERRITORY_BASELINE_NOISE_AMPLITUDE = 0.75;

/**
 * CONTINUOUS CONVICTION SCALING (2026-07-28 fix): a live, real match
 * surfaced this — a real, moderate, SUSTAINED territory lead (the exact
 * "3-8 tile-share points" band a human glancing at the map reads as an
 * obvious leader) produced a weight spread that only barely, and
 * inconsistently, cleared `SyntheticCrowdConfig`'s default trade
 * `threshold` (also 3). The prior fix (`TERRITORY_FLAT_SIGNAL_SPREAD_THRESHOLD`,
 * a hard `spread < 3` gate that added baseline noise below it and nothing
 * at all above it) measurably made this WORSE at the boundary: below the
 * gate, noise sized for a THIRD branch's tiny weight scale (see
 * `TERRITORY_BASELINE_NOISE_AMPLITUDE` above) was negligible next to this
 * branch's ~0-100 weight scale, so it barely nudged anything; at or above
 * the gate, the real (but still modest) organic spread was left
 * completely unassisted. Measured directly against the real driver
 * pipeline (`/tmp/measure_moderate_lead.ts`, production defaults, 10
 * seeds/point): a 1.3-2.7pt spread traded in only 5/10 seeds within 60s
 * — and identically regardless of which seat actually led, proof the
 * outcome was pure noise, uncorrelated with the real signal — while a
 * 4.0pt spread traded in 10/10 but with half the seeds landing at
 * 53-55s, hugging the 60s bar. A binary gate cannot fix a boundary
 * problem; by construction it always has one.
 *
 * The fix replaces the gate with two continuous functions of the ALREADY
 * EMA-smoothed, confidence-ramped spread (`spreadPts` in `deriveSnapshot`
 * below) — nothing upstream of `scaled` changes, so the memory and ramp
 * protections `Convergence` and `CrowdSilence` proved stay exactly as
 * they were:
 *
 * 1. `TERRITORY_SPREAD_BOOST_MAX`/`TERRITORY_SPREAD_BOOST_HALF_LIFE_PTS`:
 *    a multiplicative gain on each alive seat's deviation from an equal
 *    share, at its highest at `spreadPts` 0 (where it is inert anyway —
 *    a real deviation of zero stays zero no matter the gain) and decaying
 *    smoothly toward 1x (no effect) as `spreadPts` grows past a few
 *    multiples of `TERRITORY_SPREAD_BOOST_HALF_LIFE_PTS`. This is what
 *    turns a real-but-modest lead into a bigger, still correctly
 *    DIRECTIONAL fair-value gap — unlike noise, it can never manufacture
 *    a leader that the underlying evidence doesn't already point to,
 *    because it scales an existing signed deviation rather than adding an
 *    unsigned random one; a spread that is genuinely zero (a real tie)
 *    gets zero help from it, by construction.
 * 2. `TERRITORY_REAL_SIGNAL_NOISE_AMPLITUDE_PTS`/`TERRITORY_SIGNAL_FADE_SPREAD_PTS`:
 *    the genuinely-flat case (an exact or near-exact tie, where gain
 *    alone cannot help because there is no signed deviation to amplify)
 *    still gets the same small, symmetric, freshly-redrawn-every-poll
 *    baseline-liquidity nudge the old gate provided below its cutoff —
 *    just correctly scaled to this branch's own ~0-100 weight range
 *    instead of borrowing the null-branch's constant — and its
 *    contribution now fades smoothly to zero as `spreadPts` grows past
 *    `TERRITORY_SIGNAL_FADE_SPREAD_PTS`, instead of switching off at a
 *    hard cutoff, so it never competes with or masks a real signal once
 *    one exists and never leaves a dead zone where neither noise nor gain
 *    is doing anything.
 *
 * A large, already-decisive real lead (tens of points) is left almost
 * exactly as the raw EMA/ramp signal already priced it: `gain` has
 * decayed back near 1x and the noise term has fully faded, so this fix
 * cannot inflate an already-strong, already-tradeable signal into
 * overreaction — it only fills the specific dead zone between "no
 * evidence" and "obviously decisive."
 */
const TERRITORY_SPREAD_BOOST_MAX = 2.5;
const TERRITORY_SPREAD_BOOST_HALF_LIFE_PTS = 6;
const TERRITORY_REAL_SIGNAL_NOISE_AMPLITUDE_PTS = 8;
const TERRITORY_SIGNAL_FADE_SPREAD_PTS = 6;

/**
 * How long the driver waits, from the first poll with anything actually
 * released, before reporting an idle crowd. Matches the "within a minute"
 * acceptance bar: a crowd that is enabled and has real content to react to
 * but has placed zero trades after this long is producing exactly the
 * silent-but-looks-fine failure this module exists to end.
 */
const SYNTHETIC_CROWD_IDLE_WARNING_MS = 60_000;

/**
 * Polls a live premiere's release tap and drives a `SyntheticCrowdSimulator`
 * from it. One instance per premiere; construct, `start()` once the
 * premiere target is live, `stop()` on teardown/reclamation/settlement.
 */
export class SyntheticCrowdLiveDriver {
  private readonly simulator: SyntheticCrowdSimulator;
  private readonly options: SyntheticCrowdLiveDriverOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeenSequence = -1;
  /** Long-memory EMA of each seat's real territory share (0..1), carried across polls. */
  private readonly territoryLevel = new Map<string, number>();
  private territoryTable: SyntheticCrowdTerritoryTable | null = null;
  private territoryLoadStarted = false;
  /** Set (never thrown) if the background precompute rejects — the idle report below distinguishes "still pending" from "failed" using this. */
  private territoryLoadError: unknown = null;
  private readonly territoryAbort = new AbortController();
  /** Independent of the simulator's own bettor RNG — only ever used for the small baseline-liquidity nudge below, seeded off the same config so a premiere's crowd behaviour stays fully reproducible. */
  private readonly baselineNoise: Prng;
  private stopped = false;
  /** Wall-clock time of the first poll that had anything newly released — the idle-warning clock starts here, not at `start()`, so a premiere admitted well before `scheduledAt` doesn't trip a false "idle" report while genuinely nothing has happened yet. */
  private firstActivityAtMs: number | null = null;
  private anyTradeObserved = false;
  private idleWarned = false;

  constructor(options: SyntheticCrowdLiveDriverOptions) {
    this.options = options;
    this.simulator = new SyntheticCrowdSimulator({
      config: options.config,
      target: options.target,
    });
    this.baselineNoise = new Prng((options.config.seed ^ 0x9e3779b9) >>> 0);
  }

  start(): void {
    if (this.timer !== null || this.stopped || !this.options.config.enabled) {
      return;
    }
    this.beginTerritoryLoad();
    const intervalMs = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.territoryAbort.abort();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fire-and-forget: never blocks `start()`, never throws out of it. Resolves the whole-match table once, in the background. */
  private beginTerritoryLoad(): void {
    if (this.territoryLoadStarted || this.options.territory === undefined) return;
    this.territoryLoadStarted = true;
    const { projector, gate, drafts } = this.options.territory;
    projector
      .project({ gate, drafts, seatIds: this.options.seatIds, signal: this.territoryAbort.signal })
      .then((table) => {
        this.territoryTable = table;
      })
      .catch((error) => {
        this.territoryLoadError = error;
        this.options.onError?.(error);
      });
  }

  private async pollOnce(): Promise<void> {
    try {
      const records = this.options.runtime.readLiveProjection(this.lastSeenSequence);
      if (records.length === 0) return;
      this.firstActivityAtMs ??= Date.now();
      this.lastSeenSequence = records[records.length - 1].sequence;
      const visibleSequence = this.options.runtime.readLiveVisibleSequence();
      const matchProgress =
        this.options.finalSequence > 0
          ? Math.min(1, Math.max(0, visibleSequence / this.options.finalSequence))
          : 0;
      const snapshot = this.deriveSnapshot(matchProgress);
      const frameResult = await this.simulator.onReleasedFrame({
        snapshot,
        matchProgress,
        // -1 is the "nothing observed yet" sentinel `createViewerSession`
        // always accepts (ReplayPremiereInteractions.assertAuthoritative
        // ObservedSequence short-circuits on it) — synthetic bots don't
        // track a real per-session observed-sequence heartbeat the way a
        // real viewer client does, and the coarser chunk-release-based
        // check that field is validated against is unrelated to (and can
        // lag) the fine-grained `liveVisibleSequence` orders are sequenced
        // against below.
        observedSequence: -1,
      });
      if (frameResult.entries.some((entry) => entry.kind === "order")) {
        this.anyTradeObserved = true;
      }
      this.reportIdleCrowdIfDue();
      const state = this.options.target.readMarketState(null);
      if (state !== null && state.status === "settled") this.stop();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Never fail quiet: once there has been a full minute of real released content with zero trades, say exactly why — once. */
  private reportIdleCrowdIfDue(): void {
    if (
      this.idleWarned ||
      this.anyTradeObserved ||
      this.firstActivityAtMs === null ||
      Date.now() - this.firstActivityAtMs < SYNTHETIC_CROWD_IDLE_WARNING_MS
    ) {
      return;
    }
    this.idleWarned = true;
    const reason =
      this.options.territory === undefined
        ? "no territory precompute was configured for this driver; the crowd is baseline-liquidity-only by design"
        : this.territoryLoadError !== null
          ? `territory precompute failed: ${
              this.territoryLoadError instanceof Error
                ? this.territoryLoadError.message
                : String(this.territoryLoadError)
            }`
          : this.territoryTable === null
            ? "territory precompute has not resolved yet"
            : "territory data is available but no order has cleared the crowd's trade threshold yet";
    this.options.onError?.(
      new Error(`synthetic_crowd_idle: enabled crowd produced no trades within 60s — ${reason}`),
    );
  }

  private deriveSnapshot(matchProgress: number): SyntheticCrowdSignalSnapshot {
    const seatIds = this.options.seatIds;
    const weights: Record<string, number> = {};
    // Integrity rule: NEVER look up a sample past what has actually been
    // released. `lastSeenSequence` is this driver's own bookkeeping of the
    // highest sequence `readLiveProjection` has handed it — the same bound
    // every other signal this driver derives is already held to.
    const sample =
      this.territoryTable === null
        ? null
        : syntheticCrowdTerritorySampleAtOrBefore(this.territoryTable, this.lastSeenSequence);

    if (sample === null) {
      // Precompute still running, unavailable, or nothing released yet
      // reaches the table's first row: no legitimate basis to prefer any
      // seat over another. Flat evidence — but NOT a flat market: baseline
      // noise keeps the crowd trading (see `TERRITORY_BASELINE_NOISE_AMPLITUDE`)
      // instead of ticking forever at an exact, gap-proof tie with the
      // market's own flat opening price.
      for (const seatId of seatIds) {
        this.territoryLevel.set(seatId, 0);
        weights[seatId] = TERRITORY_FLOOR + this.baselineNoise.next() * TERRITORY_BASELINE_NOISE_AMPLITUDE;
      }
      return { optionSeatIds: [...seatIds], favorabilityWeights: weights };
    }

    const totalTiles = seatIds.reduce(
      (sum, id) => sum + Math.max(0, sample.tilesOwned[id] ?? 0),
      0,
    );
    const equalShare = 1 / seatIds.length;
    const confidence = Math.min(1, Math.max(0, matchProgress) / TERRITORY_CONFIDENCE_RAMP_PROGRESS);

    const deadSeatIds = new Set<string>();
    const aliveScaledPts: Record<string, number> = {};
    for (const seatId of seatIds) {
      const tiles = Math.max(0, sample.tilesOwned[seatId] ?? 0);
      if (tiles <= 0) {
        // Structural, not statistical: a seat holding zero tiles right now
        // has zero legitimate basis for a nonzero price, however strong
        // its conviction was before it got there. Reset immediately
        // rather than let the long memory below carry a stale, now-false
        // lead across an elimination — the "priced a dead seat at
        // 32-40%" finding this fix exists to close. No baseline noise
        // either: a dead seat gets no reason at all to trade above the
        // floor.
        this.territoryLevel.set(seatId, 0);
        weights[seatId] = TERRITORY_FLOOR;
        deadSeatIds.add(seatId);
        continue;
      }
      const share = totalTiles > 0 ? tiles / totalTiles : equalShare;
      const prior = this.territoryLevel.get(seatId) ?? share;
      // Conviction builds with sustained evidence, decays slowly when it
      // weakens: a long-half-life EMA of the real per-frame territory
      // share, not the instantaneous read itself.
      const conviction = prior + (1 - TERRITORY_CONVICTION_DECAY) * (share - prior);
      this.territoryLevel.set(seatId, conviction);
      // Early-match dampening blends the SUSTAINED belief (not the one-
      // frame read) back toward "no clear leader yet" in proportion to how
      // little of the match has been seen.
      const scaled = equalShare + confidence * (conviction - equalShare);
      aliveScaledPts[seatId] = Math.max(0, scaled) * 100;
    }
    // Continuous conviction scaling (see the constants' own docs above):
    // replaces the old binary "spread < 3 ? add noise : add nothing" gate
    // with two smooth functions of the ALREADY EMA-smoothed,
    // confidence-ramped spread — a multiplicative `gain` that amplifies
    // each seat's real, signed deviation from an equal share (strongest
    // when the raw spread is small, fading to a no-op once the spread is
    // already decisive), and a small symmetric noise nudge that only
    // matters when `gain` cannot help — a genuinely flat/tied signal,
    // where every deviation is already zero — and which itself fades to
    // zero as real spread grows, so it never lingers once genuine
    // evidence exists.
    const equalSharePts = equalShare * 100;
    const aliveSeatIds = seatIds.filter((seatId) => !deadSeatIds.has(seatId));
    if (aliveSeatIds.length > 0) {
      const ptsValues = aliveSeatIds.map((seatId) => aliveScaledPts[seatId]);
      const spreadPts = Math.max(...ptsValues) - Math.min(...ptsValues);
      const gain =
        1 + TERRITORY_SPREAD_BOOST_MAX / (1 + spreadPts / TERRITORY_SPREAD_BOOST_HALF_LIFE_PTS);
      const noiseFade = Math.max(0, 1 - spreadPts / TERRITORY_SIGNAL_FADE_SPREAD_PTS);
      for (const seatId of aliveSeatIds) {
        const deviationPts = aliveScaledPts[seatId] - equalSharePts;
        const amplifiedPts = equalSharePts + deviationPts * gain;
        const noisePts =
          this.baselineNoise.next() * TERRITORY_REAL_SIGNAL_NOISE_AMPLITUDE_PTS * noiseFade;
        weights[seatId] = Math.max(0, amplifiedPts) + noisePts + TERRITORY_FLOOR;
      }
    }
    return { optionSeatIds: [...seatIds], favorabilityWeights: weights, deadSeatIds };
  }
}
