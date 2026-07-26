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
    // Sharpens conviction toward the top pick as aggressiveness rises.
    const sharpenPower = 1 + aggressiveness;
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
    return normalizedFairValues(extrapolated, seatIds);
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
    if (input.remainingBudgetHint < input.minStake) {
      return null;
    }
    const stake = Math.min(
      input.remainingBudgetHint,
      rng.nextInt(input.minStake, input.maxStake),
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
    const sellShares = Math.max(1, Math.floor(held / 2));
    return {
      seatId: bestSeatId,
      side: "sell",
      amount: sellShares,
      limitPrice: Math.max(0, price - slippageSlack),
    };
  }
  return null;
}
