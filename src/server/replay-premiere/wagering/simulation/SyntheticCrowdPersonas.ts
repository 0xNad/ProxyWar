import type { Prng } from "./SyntheticCrowdPrng";
import type {
  SyntheticCrowdPersonaKind,
  SyntheticCrowdSignalSnapshot,
} from "./SyntheticCrowdTypes";

export interface SyntheticCrowdDecisionInput {
  readonly persona: SyntheticCrowdPersonaKind;
  readonly snapshot: SyntheticCrowdSignalSnapshot;
  /** Current display prices (0..100), keyed by seatId. */
  readonly marketPrices: Readonly<Record<string, number>>;
  /** Shares this bot currently holds, keyed by seatId. */
  readonly heldShares: Readonly<Record<string, number>>;
  /** Prices this bot last observed (any prior window), for momentum. Null on a bot's first-ever action. */
  readonly lastSeenPrices: Readonly<Record<string, number>> | null;
  readonly remainingBudgetHint: number;
  readonly minStake: number;
  readonly maxStake: number;
  readonly threshold: number;
  readonly aggressiveness: number;
  readonly rng: Prng;
}

export interface SyntheticCrowdDecision {
  readonly seatId: string;
  readonly side: "buy" | "sell";
  /** Buy: chip budget to spend. Sell: exact share count. */
  readonly amount: number;
  readonly limitPrice: number;
}

/** Normalises non-negative per-seat weights to display-price scale (sums to 100). Falls back to uniform if every weight is zero/missing. */
function normalizedFairValues(
  weights: Readonly<Record<string, number>>,
  seatIds: readonly string[],
): Record<string, number> {
  let total = 0;
  for (const seatId of seatIds) {
    total += Math.max(0, weights[seatId] ?? 0);
  }
  if (total <= 0) {
    const uniform = 100 / seatIds.length;
    return Object.fromEntries(seatIds.map((seatId) => [seatId, uniform]));
  }
  return Object.fromEntries(
    seatIds.map((seatId) => [
      seatId,
      (100 * Math.max(0, weights[seatId] ?? 0)) / total,
    ]),
  );
}

/**
 * How lopsided the raw snapshot already is, 0 (perfectly uniform — every
 * seat tied) to 1 (one seat holds effectively the entire signal). Used to
 * let a persona's conviction scale with the strength of the evidence
 * instead of being a flat function of `aggressiveness` alone: a seat
 * sitting on a real, sustained lead should earn sharper belief than the
 * same aggressiveness dial would produce from a genuinely close snapshot.
 */
function evidenceConcentration(
  weights: Readonly<Record<string, number>>,
  seatIds: readonly string[],
): number {
  const shares = normalizedFairValues(weights, seatIds);
  const uniform = 100 / seatIds.length;
  const maxShare = Math.max(...seatIds.map((seatId) => shares[seatId] ?? 0));
  return Math.max(0, Math.min(1, (maxShare - uniform) / (100 - uniform)));
}

/**
 * Per-persona transform of the frozen snapshot (plus, for the momentum
 * persona, the bot's own memory of prices it has already observed — public
 * market data, not privileged game state) into a fair-value target the
 * persona believes in. This is where "differing priors" comes from: four
 * personas looking at the same snapshot reach four different conclusions.
 */
function personaFairValues(
  input: SyntheticCrowdDecisionInput,
): Record<string, number> {
  const seatIds = input.snapshot.optionSeatIds;
  const { persona, snapshot, marketPrices, lastSeenPrices, rng, aggressiveness } =
    input;
  if (persona === "favorite-backer") {
    // Sharpens conviction toward the top pick as aggressiveness rises —
    // and, on top of that, as the snapshot's own evidence concentration
    // rises: a 25/25/25/25 tie gets the same treatment as before
    // (concentration 0 leaves `sharpenPower` at the plain `1 +
    // aggressiveness` baseline), but a snapshot where one seat clearly
    // dominates earns extra sharpening at the same aggressiveness dial —
    // "push hard when dominant, stay uncertain when it's genuinely
    // close." At aggressiveness 0 this is still an exact no-op
    // (0 * anything === 0), preserving the persona's baseline identity
    // behaviour.
    const concentration = evidenceConcentration(snapshot.favorabilityWeights, seatIds);
    const sharpenPower = 1 + aggressiveness * (1 + 2 * concentration);
    const sharpened = Object.fromEntries(
      seatIds.map((seatId) => [
        seatId,
        Math.pow(Math.max(0, snapshot.favorabilityWeights[seatId] ?? 0), sharpenPower),
      ]),
    );
    return normalizedFairValues(sharpened, seatIds);
  }
  if (persona === "value-hunter") {
    // Flattens toward uniform — believes longshots are more live than the
    // crowd-consensus signal implies, so it hunts underpriced underdogs.
    const softenPower = 1 / (1 + aggressiveness);
    const softened = Object.fromEntries(
      seatIds.map((seatId) => [
        seatId,
        Math.pow(Math.max(0, snapshot.favorabilityWeights[seatId] ?? 0), softenPower),
      ]),
    );
    return normalizedFairValues(softened, seatIds);
  }
  if (persona === "momentum-chaser") {
    if (lastSeenPrices === null) {
      // Nothing to extrapolate yet — starts from the same public signal
      // everyone else has.
      return normalizedFairValues(snapshot.favorabilityWeights, seatIds);
    }
    const momentumGain = 1 + aggressiveness;
    const extrapolated = Object.fromEntries(
      seatIds.map((seatId) => {
        const price = marketPrices[seatId] ?? 0;
        const prior = lastSeenPrices[seatId] ?? price;
        const projected = price + (price - prior) * momentumGain;
        return [seatId, Math.max(0, Math.min(100, projected))];
      }),
    );
    // Pure trend extrapolation is unmoored from any ground truth: a small
    // early price wobble (from noise, or even this same persona's own
    // prior buy) gets amplified by `momentumGain` every frame with
    // nothing to check it, which can spiral into a self-reinforcing
    // bubble on a seat with zero actual informational edge — exactly the
    // "whipsaws... with zero informational trigger" finding. Blending in
    // the real snapshot signal (still weighted toward the extrapolated
    // trend, so this persona keeps its distinct "chase the tape" belief —
    // see the existing test where it still buys a rallying seat the raw
    // snapshot disagrees with) gives momentum somewhere to fall back to
    // once the seat it's chasing has no real evidence behind it.
    const rawSignal = normalizedFairValues(snapshot.favorabilityWeights, seatIds);
    const blended = Object.fromEntries(
      seatIds.map((seatId) => [
        seatId,
        0.65 * extrapolated[seatId] + 0.35 * (rawSignal[seatId] ?? 0),
      ]),
    );
    return normalizedFairValues(blended, seatIds);
  }
  // "noise-trader": the public signal blended with fresh idiosyncratic
  // jitter — small, mostly-random trades that add genuine microstructure
  // noise without being the whole crowd's behaviour.
  const jittered = Object.fromEntries(
    seatIds.map((seatId) => [
      seatId,
      Math.max(0, (snapshot.favorabilityWeights[seatId] ?? 0) + rng.next() * 40),
    ]),
  );
  return normalizedFairValues(jittered, seatIds);
}

/**
 * Ported decision core from the prior engine's `Crowd.actOne`: pick the
 * most-mispriced outcome (|fair value − price|, small seeded tiebreak),
 * buy if under-priced past `threshold`, trim half a holding if over-priced
 * past `threshold`. Returns null if nothing clears the threshold.
 */
export function decideSyntheticCrowdOrder(
  input: SyntheticCrowdDecisionInput,
): SyntheticCrowdDecision | null {
  const { snapshot, marketPrices, heldShares, threshold, rng, aggressiveness } =
    input;
  const fairValues = personaFairValues(input);
  let bestSeatId: string | null = null;
  let bestMagnitude = 0;
  for (const seatId of snapshot.optionSeatIds) {
    // A seat the released data has already ruled out (zero held) is never
    // a legitimate BUY candidate, however large a persona's own derived
    // fair value looks — momentum-chaser in particular extrapolates pure
    // price trend and can otherwise manufacture a buy signal on a dead
    // seat from nothing but its own recent price noise. If this bot
    // already holds some (bought while the seat was still alive), it
    // stays a candidate so the sell branch below can wind the position
    // down; a zero-held dead seat is excluded entirely rather than left
    // to lose the argmax comparison on its own, so it can never win by
    // outbidding a smaller-but-genuine gap elsewhere either.
    if (snapshot.deadSeatIds?.has(seatId) && (heldShares[seatId] ?? 0) <= 0) {
      continue;
    }
    const gap = fairValues[seatId] - (marketPrices[seatId] ?? 0);
    const magnitude = Math.abs(gap) + rng.next() * 0.5;
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestSeatId = seatId;
    }
  }
  if (bestSeatId === null) {
    return null;
  }
  const price = marketPrices[bestSeatId] ?? 0;
  const gap = fairValues[bestSeatId] - price;
  // Generous on purpose: a multi-share buy's AVERAGE fill price (what
  // limitPrice actually gates) can run well past the single-share quote
  // this decision priced off of, especially in a thin/demo-scale market —
  // exactly where a synthetic crowd is meant to operate. A near-zero
  // tolerance would make most orders spuriously reject on their own
  // intended price impact rather than genuinely bad execution.
  const slippageSlack = 6 + aggressiveness * 24;
  if (gap > threshold) {
    // Never buy a seat the released data has already ruled out, however
    // large a persona's own derived fair value looks (see the candidate
    // loop above for why this can happen at all) — this only matters
    // when this bot already holds some (the loop above admits a
    // zero-held dead seat as a candidate never), i.e. exactly the "add
    // to an existing dead position instead of selling it down" case.
    if (snapshot.deadSeatIds?.has(bestSeatId) || input.remainingBudgetHint < input.minStake) {
      return null;
    }
    // Conviction scales with evidence at the trade level too: a bigger
    // fair-value/price gap draws a bigger stake, instead of a flat random
    // draw across the whole min/max band regardless of how mispriced the
    // seat looks. A 40+ point gap (a seat priced near parity that the
    // crowd believes is a clear favorite, or vice versa) already earns
    // full conviction — the top of whatever this trade is allowed to
    // spend becomes the floor of its random draw rather than the
    // ceiling.
    //
    // "Allowed to spend" is capped at a THIRD of what's left, regardless
    // of conviction: this is one continuous market spanning a whole
    // match, not a single-shot bet. A bettor that goes all-in on the
    // first strong signal it sees has nothing left to react with days —
    // or, here, minutes — later when the picture changes (an early
    // signal exhausting a bot's whole bankroll on the wrong seat is
    // exactly why late-match evidence used to go unpriced).
    const conviction = Math.min(1, gap / 40);
    const spendCap = Math.max(input.minStake, Math.floor(input.remainingBudgetHint / 3));
    const stakeCeiling = Math.min(input.maxStake, spendCap);
    const stakeFloor = Math.min(
      stakeCeiling,
      Math.round(input.minStake + (input.maxStake - input.minStake) * conviction),
    );
    const stake = Math.min(
      input.remainingBudgetHint,
      rng.nextInt(stakeFloor, stakeCeiling),
    );
    return {
      seatId: bestSeatId,
      side: "buy",
      amount: Math.round(stake),
      limitPrice: Math.min(100, price + slippageSlack),
    };
  }
  if (gap < -threshold) {
    const held = heldShares[bestSeatId] ?? 0;
    if (held <= 0) {
      return null;
    }
    // A fair value this close to zero is not "overpriced, sell some" —
    // it is the structural elimination floor (see
    // `SyntheticCrowdLiveDriver.deriveSnapshot`'s `TERRITORY_FLOOR`):
    // the released data has already said this seat cannot win. Gradual
    // half-liquidation (below) is right for an ordinary rally-then-
    // overpriced seat that still has genuine value; it is wrong here,
    // where every tick spent only half-selling is a tick a bigger, real
    // mispricing elsewhere (this module's continuous conviction scaling
    // now gives moderate-but-real leads a competitive gap too) can win
    // the single-best-seat pick instead and stall the wind-down
    // indefinitely. Liquidate the whole position at once — never
    // partial, never RNG-consuming, so this changes nothing about which
    // bot/seat gets picked or how any other decision's random draws
    // sequence.
    const sellShares = snapshot.deadSeatIds?.has(bestSeatId) ? held : Math.max(1, Math.floor(held / 2));
    return {
      seatId: bestSeatId,
      side: "sell",
      amount: sellShares,
      limitPrice: Math.max(0, price - slippageSlack),
    };
  }
  return null;
}
